#!/usr/bin/env python3
"""Build and verify boxd base snapshots from the provider-neutral image bundle.

A build machine is created from boxd's stock Ubuntu image, isolated (no
metadata endpoint, no in-VM boxd CLI, none of the account's integrations or
agent logins) and private to the API key, with a delete-after timer as a
safety net. The shared installation
bundle is uploaded and installed in it, the launcher is baked next to the
runtime, the machine is rebooted so the snapshot captures a clean boot of the
installed image, and the machine is saved as a snapshot. A second machine then
restores that snapshot and runs the image verification, exactly as a session
machine will. Only the boxd API is used, through the boxd Python SDK.
"""

from __future__ import annotations

import io
import os
import re
import shlex
import sys
import tarfile
import time
import uuid
from pathlib import Path
from typing import Any, Protocol

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sandbox-images/src"))

from sandbox_images.bundle import pack_bundle  # noqa: E402
from sandbox_images.native import write_build_result  # noqa: E402

# A snapshot keeps the size of the machine it was saved from; sessions that
# ask for another size are resized by the control plane before they boot.
DEFAULT_BUILD_SIZE = "2x8"
BUILD_SIZES = {"1x4": 1, "2x8": 2, "4x16": 4, "8x32": 8}

# Layout shared with the launcher and the control plane (boxd-provider.ts).
USER_HOME = "/home/boxd"
INSTALL_HOME = f"{USER_HOME}/openinspect"
LAUNCHER_PATH = f"{INSTALL_HOME}/launcher.sh"
LAUNCHER_UPLOAD_PATH = f"{USER_HOME}/openinspect-launcher.sh"
BUNDLE_UPLOAD_PATH = f"{USER_HOME}/openinspect-image.tar.gz"
BUNDLE_EXTRACT_DIR = "/tmp/openinspect-image"
INSTALL_SCRIPT = f"{BUNDLE_EXTRACT_DIR}/packages/sandbox-images/install/install.sh"
# A fresh machine may still be running its own package maintenance; apt waits
# for the dpkg lock this long instead of failing the install outright.
APT_CONFIG_PATH = "/tmp/openinspect-apt.conf"
APT_LOCK_TIMEOUT_SECONDS = 600
VERIFY_COMMAND = "sudo /opt/openinspect/python/bin/python /app/verify/smoke_test.py verify"
# The image's SCM credential helper config and `gh` wrapper. The build pins
# them immutable before the snapshot is saved, so they stay exactly as built.
PINNED_SYSTEM_PATHS = ("/etc/gitconfig", "/usr/local/bin/gh")
# Where a detached command leaves its exit code and output for the poll.
DETACHED_DIR = "/tmp/openinspect-build-step"

SNAPSHOT_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
MACHINE_NAME_PREFIX = "oi-build"
# Marks the builder's own machines. A snapshot keeps its source's labels and
# every restore inherits them, so the build machine drops it before the save.
BUILD_LABEL = "openinspect-image-build"
TERMINAL_STATUSES = {"failed", "destroyed"}

POLL_SECONDS = 5
READY_TIMEOUT_SECONDS = 300
COMMAND_TIMEOUT_SECONDS = 300
INSTALL_TIMEOUT_SECONDS = 45 * 60
VERIFY_TIMEOUT_SECONDS = 15 * 60
SNAPSHOT_TIMEOUT_SECONDS = 30 * 60
# Platform-enforced deletes, so a build that dies half-way never leaves a
# machine running (and billing) for long.
BUILD_MACHINE_DELETE_AFTER_SECONDS = 3 * 60 * 60
VERIFY_MACHINE_DELETE_AFTER_SECONDS = 60 * 60
# Enough of each log to explain a failure; never a transcript.
LOG_TAIL_CHARS = 4000


class BoxdSdk(Protocol):
    """The parts of `boxd.Boxd` the builder uses (a fake stands in for it in tests)."""

    machines: Any
    snapshots: Any


def tail(text: Any) -> str:
    return str(text or "")[-LOG_TAIL_CHARS:]


def is_not_found(error: Exception) -> bool:
    return type(error).__name__ == "NotFoundError"


class BoxdBuilder:
    """The boxd calls used to build and verify base snapshots."""

    def __init__(self, sdk: BoxdSdk, org: str | None = None) -> None:
        self.sdk = sdk
        self.org = org
        # One name suffix per run: a later run never collides with a machine
        # a failed run left behind for its delete-after timer.
        self.run_id = uuid.uuid4().hex[:10]

    def create_machine(self, purpose: str, **params: Any) -> Any:
        """Create an isolated, private machine (never shared with the org) named for this run."""
        if "from_snapshot" not in params:
            # A restore takes no `shared`; it is private to the key regardless.
            params["shared"] = False
        machine = self.sdk.machines.create(
            f"{MACHINE_NAME_PREFIX}-{purpose}-{self.run_id}",
            org=self.org,
            isolated=True,
            labels={BUILD_LABEL: purpose},
            **params,
        )
        try:
            if machine.shared:
                self.sdk.machines.unshare(machine.id)
                if self.sdk.machines.get(machine.id).shared:
                    raise RuntimeError(f"boxd machine {machine.id} stayed shared after unshare")
        except Exception:
            self.delete_machine(machine.id)
            raise
        return machine

    def wait_ready(self, machine_id: str, timeout: int = READY_TIMEOUT_SECONDS) -> None:
        deadline = time.monotonic() + timeout
        while True:
            machine = self.sdk.machines.get(machine_id)
            if machine.status in TERMINAL_STATUSES:
                raise RuntimeError(f"boxd machine {machine_id} entered {machine.status}")
            if machine.status == "running":
                try:
                    if self.sdk.machines.exec(machine_id, "true", timeout=30).exit_code == 0:
                        return
                except Exception as error:  # a booting machine may not answer yet
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f"boxd machine {machine_id} never answered: {error}")
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"boxd machine {machine_id} not ready after {timeout}s ({machine.status})"
                )
            time.sleep(POLL_SECONDS)

    def run(self, machine_id: str, command: str, timeout_seconds: int) -> Any:
        """Run `command` to completion and fail on a non-zero exit."""
        result = self.sdk.machines.exec(machine_id, command, timeout=timeout_seconds)
        if result.exit_code != 0:
            raise RuntimeError(
                f"Command failed in {machine_id} (exit {result.exit_code}): {command}\n"
                f"{tail(result.stdout)}\n{tail(result.stderr)}"
            )
        return result

    def run_detached(self, machine_id: str, command: str, timeout: int) -> None:
        """Start `command` in the background and wait for it, failing on a non-zero exit.

        A long install is not held on one exec stream: it runs under setsid
        from a script file, writes its exit code to a file, and the builder
        polls that file.
        """
        self.run(
            machine_id, f"rm -rf {DETACHED_DIR} && mkdir -p {DETACHED_DIR}", COMMAND_TIMEOUT_SECONDS
        )
        self.write_file(machine_id, f"{DETACHED_DIR}/step.sh", f"{command}\n".encode())
        self.run(
            machine_id,
            f"setsid nohup bash -c 'bash {DETACHED_DIR}/step.sh; echo $? > {DETACHED_DIR}/exit' "
            f"> {DETACHED_DIR}/log 2>&1 < /dev/null &",
            COMMAND_TIMEOUT_SECONDS,
        )
        deadline = time.monotonic() + timeout
        while True:
            status = self.sdk.machines.exec(
                machine_id, f"cat {DETACHED_DIR}/exit 2>/dev/null || true", timeout=30
            )
            exited = str(status.stdout).strip()
            if exited:
                if exited != "0":
                    log_tail = self.sdk.machines.exec(
                        machine_id, f"tail -c {LOG_TAIL_CHARS} {DETACHED_DIR}/log", timeout=30
                    ).stdout
                    raise RuntimeError(
                        f"Command failed in {machine_id} (exit {exited}): {command}\n{tail(log_tail)}"
                    )
                return
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Command did not finish within {timeout}s: {command}")
            time.sleep(POLL_SECONDS)

    def write_file(self, machine_id: str, path: str, content: bytes) -> None:
        self.sdk.machines.files.upload(machine_id, path, content)

    def drop_build_label(self, machine_id: str) -> None:
        self.sdk.machines.update_labels(machine_id, remove=[BUILD_LABEL])

    def reboot_and_wait(self, machine_id: str) -> None:
        self.sdk.machines.reboot(machine_id)
        # A reboot answers before the machine is down; wait for it to come back.
        time.sleep(POLL_SECONDS)
        self.wait_ready(machine_id)

    def delete_machine(self, machine_id: str) -> None:
        try:
            self.sdk.machines.delete(machine_id)
        except Exception as error:
            if not is_not_found(error):
                raise

    def get_snapshot(self, name: str) -> Any | None:
        try:
            return self.sdk.snapshots.get(name, org=self.org)
        except Exception as error:
            if is_not_found(error):
                return None
            raise

    def save_snapshot(
        self, machine_id: str, name: str, timeout: int = SNAPSHOT_TIMEOUT_SECONDS
    ) -> Any:
        self.sdk.snapshots.create(machine_id, name)
        return self.wait_snapshot(name, timeout)

    def wait_snapshot(self, name: str, timeout: int = SNAPSHOT_TIMEOUT_SECONDS) -> Any:
        deadline = time.monotonic() + timeout
        while True:
            snapshot = self.get_snapshot(name)
            if snapshot is None:
                raise RuntimeError(f"boxd snapshot {name} disappeared while saving")
            if snapshot.status == "ready":
                return snapshot
            if snapshot.status == "failed":
                raise RuntimeError(f"boxd snapshot {name} failed")
            if time.monotonic() >= deadline:
                raise RuntimeError(f"boxd snapshot {name} not ready after {timeout}s")
            time.sleep(POLL_SECONDS)


def pack_archive(directory: Path) -> bytes:
    """A gzip tarball of the staged bundle, modes and symlinks preserved."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        archive.add(directory, arcname=".", recursive=True)
    return buffer.getvalue()


def prepare_command() -> str:
    """Unpack the bundle and place the launcher (as `boxd`)."""
    return " && ".join(
        [
            f"mkdir -p {INSTALL_HOME} {BUNDLE_EXTRACT_DIR}",
            f"tar -xzf {shlex.quote(BUNDLE_UPLOAD_PATH)} -C {BUNDLE_EXTRACT_DIR}",
            f"install -m 0755 {shlex.quote(LAUNCHER_UPLOAD_PATH)} {shlex.quote(LAUNCHER_PATH)}",
            f"printf 'DPkg::Lock::Timeout \"{APT_LOCK_TIMEOUT_SECONDS}\";\\n' > {APT_CONFIG_PATH}",
        ]
    )


def install_command() -> str:
    """Run the shared installer as root with the apt lock wait applied."""
    return f"sudo env APT_CONFIG={APT_CONFIG_PATH} bash {INSTALL_SCRIPT}"


def cleanup_command() -> str:
    """Remove build inputs so the snapshot holds only the installed image."""
    return " && ".join(
        [
            f"rm -rf {BUNDLE_EXTRACT_DIR} {APT_CONFIG_PATH} {DETACHED_DIR} "
            f"{shlex.quote(BUNDLE_UPLOAD_PATH)} {shlex.quote(LAUNCHER_UPLOAD_PATH)}",
            # Never bake a first-boot marker or a session env: a restore is a fresh boot.
            f"rm -rf {USER_HOME}/.openinspect",
            "sudo rm -rf /root/.npm /root/.cache",
            "sync",
        ]
    )


def pin_command() -> str:
    """Pin the image's git credential helper config and gh wrapper immutable."""
    paths = " ".join(PINNED_SYSTEM_PATHS)
    return f"sudo chattr +i {paths} && lsattr {paths}"


def validate_base_prefix(prefix: str) -> None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,45}", prefix):
        raise RuntimeError("BOXD_BASE_SNAPSHOT must be 1-46 lowercase letters, digits or dashes")


def candidate_name(prefix: str, build_hash: str) -> str:
    validate_base_prefix(prefix)
    name = (
        os.environ.get("OPENINSPECT_IMAGE_CANDIDATE")
        or f"{prefix}-{build_hash[:12]}-{time.time_ns()}"
    )
    if not SNAPSHOT_NAME_PATTERN.fullmatch(name):
        raise RuntimeError(
            f"boxd snapshot name {name!r} must be 1-63 lowercase letters, digits or dashes; "
            "shorten BOXD_BASE_SNAPSHOT"
        )
    return name


def build_snapshot(builder: BoxdBuilder, name: str, bundle_directory: Path, size: str) -> None:
    archive = pack_archive(bundle_directory)
    launcher = (Path(__file__).resolve().parent / "launcher.sh").read_bytes()
    machine = builder.create_machine(
        "build", vcpu=BUILD_SIZES[size], delete_after=BUILD_MACHINE_DELETE_AFTER_SECONDS
    )
    machine_id = machine.id
    print(f"boxd image build machine {machine.name} ({size})", flush=True)
    try:
        builder.wait_ready(machine_id)
        builder.write_file(machine_id, BUNDLE_UPLOAD_PATH, archive)
        builder.write_file(machine_id, LAUNCHER_UPLOAD_PATH, launcher)
        builder.run(machine_id, prepare_command(), COMMAND_TIMEOUT_SECONDS)
        builder.run_detached(machine_id, install_command(), INSTALL_TIMEOUT_SECONDS)
        builder.run(machine_id, cleanup_command(), COMMAND_TIMEOUT_SECONDS)
        builder.run(machine_id, pin_command(), COMMAND_TIMEOUT_SECONDS)
        # A snapshot captures memory too: reboot so it holds a clean boot of the
        # installed image, not the installer's leftovers.
        builder.reboot_and_wait(machine_id)
        builder.drop_build_label(machine_id)
        builder.save_snapshot(machine_id, name)
        print(f"boxd snapshot {name} saved", flush=True)
    finally:
        builder.delete_machine(machine_id)


def verify_snapshot(builder: BoxdBuilder, name: str) -> None:
    """A fresh restore both verifies the final artifact and exercises the launcher's preparation."""
    machine = builder.create_machine(
        "verify", from_snapshot=name, delete_after=VERIFY_MACHINE_DELETE_AFTER_SECONDS
    )
    machine_id = machine.id
    print(f"boxd image verification machine {machine.name}", flush=True)
    try:
        builder.wait_ready(machine_id)
        builder.run(
            machine_id, f"bash {shlex.quote(LAUNCHER_PATH)} --prepare-only", COMMAND_TIMEOUT_SECONDS
        )
        builder.run_detached(machine_id, VERIFY_COMMAND, VERIFY_TIMEOUT_SECONDS)
    except Exception as error:
        raise RuntimeError(f"boxd image verification failed: {error}") from error
    finally:
        builder.delete_machine(machine_id)


def connect() -> BoxdSdk:
    """The boxd client for BOXD_API_KEY (and BOXD_REGION / BOXD_API_URL when set)."""
    from boxd import Boxd

    return Boxd(
        api_key=os.environ["BOXD_API_KEY"],
        region=os.environ.get("BOXD_REGION") or None,
        base_url=os.environ.get("BOXD_API_URL") or None,
    )


def main(argv: list[str] | None = None, sdk: BoxdSdk | None = None) -> None:
    del argv
    api_key = os.environ.get("BOXD_API_KEY")
    prefix = os.environ.get("BOXD_BASE_SNAPSHOT")
    if not api_key or not prefix:
        raise RuntimeError("BOXD_BASE_SNAPSHOT and BOXD_API_KEY are required")
    validate_base_prefix(prefix)
    size = os.environ.get("BOXD_BUILD_SIZE") or DEFAULT_BUILD_SIZE
    if size not in BUILD_SIZES:
        raise RuntimeError(f"BOXD_BUILD_SIZE must be one of {', '.join(BUILD_SIZES)}")
    builder = BoxdBuilder(sdk or connect(), os.environ.get("BOXD_ORG") or None)

    bundle = pack_bundle(ROOT, "boxd", ROOT / ".cache/sandbox-images")
    name = candidate_name(prefix, bundle.plan["buildHash"])

    existing = builder.get_snapshot(name)
    if existing is not None and existing.status == "pending":
        existing = builder.wait_snapshot(name)
    if existing is None:
        build_snapshot(builder, name, bundle.directory, size)
    elif existing.status == "ready":
        # A retry re-verifies the retained artifact instead of rebuilding it.
        print(f"boxd snapshot {name} already exists; verifying it", flush=True)
    else:
        # A failed snapshot keeps its name, and the name is fixed by the
        # inputs: stop before anything is billed; the artifact is the
        # operator's to remove.
        raise RuntimeError(
            f"boxd snapshot {name} exists with status {existing.status!r}; "
            "delete it before rebuilding"
        )
    verify_snapshot(builder, name)
    write_build_result(name)


if __name__ == "__main__":
    main()
