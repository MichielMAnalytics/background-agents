#!/usr/bin/env python3
"""Build and verify the boxd base snapshot; configuration and flow in README.md.

A build machine boots from boxd's stock Ubuntu image, isolated, with none of the
account's secrets. The shared installation bundle and this directory's boot
files are uploaded and installed in it, and the machine is saved as a named
snapshot. A second machine is then created from that snapshot and runs the
image verification, exactly as a session machine boots.
"""

from __future__ import annotations

import contextlib
import io
import os
import re
import shlex
import sys
import tarfile
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from boxd import Boxd

ROOT = Path(__file__).resolve().parents[2]
INFRA = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "packages/sandbox-images/src"))

from sandbox_images.bundle import pack_bundle  # noqa: E402
from sandbox_images.native import write_build_result  # noqa: E402

DEFAULT_SNAPSHOT_PREFIX = "openinspect-sandbox"
BUILD_HASH_NAME_CHARS = 16
SNAPSHOT_PREFIX_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,37}$")
IMAGE_BUILD_LABEL = "openinspect/image-build"
# Every session machine has the size of the machine the snapshot was saved
# from: BOXD_SANDBOX_VCPU picks it, with 4 GiB of memory per vCPU.
DEFAULT_SANDBOX_VCPU = 2
SANDBOX_VCPU_CHOICES = (1, 2, 4, 8)
GIB_PER_VCPU = 4

# What the image installs from this directory, and where.
BOXD_FILES = {
    "launcher.sh": ("/opt/openinspect/boxd/launcher.sh", "0755"),
    "exec-runtime.py": ("/opt/openinspect/boxd/exec-runtime.py", "0755"),
    "openinspect-sandbox.service": ("/etc/systemd/system/openinspect-sandbox.service", "0644"),
}
# The machine user's home; boxd's file API writes as that user.
MACHINE_HOME = "/home/boxd"
UPLOAD_DIR = f"{MACHINE_HOME}/openinspect-image-upload"
BUNDLE_UPLOAD_PATH = f"{UPLOAD_DIR}/bundle.tar.gz"
BUNDLE_EXTRACT_DIR = "/tmp/openinspect-image"
INSTALL_SCRIPT = f"{BUNDLE_EXTRACT_DIR}/packages/sandbox-images/install/install.sh"
# The control plane writes each session's environment here (mode 0600) before
# `launcher.sh accept` moves it into /etc/openinspect.
SESSION_INBOX_DIR = f"{MACHINE_HOME}/.openinspect"
INSTALL_UNIT = "openinspect-image-install"
VERIFY_COMMAND = "sudo /opt/openinspect/python/bin/python /app/verify/smoke_test.py verify"

READY_TIMEOUT_SECONDS = 300
STEP_TIMEOUT_SECONDS = 300
INSTALL_TIMEOUT_SECONDS = 60 * 60
VERIFY_TIMEOUT_SECONDS = 20 * 60
SNAPSHOT_TIMEOUT_SECONDS = 30 * 60
POLL_INTERVAL_SECONDS = 10
# Enough of each log to explain a failure; never a transcript.
LOG_TAIL_CHARS = 4000


class ImageBuildError(RuntimeError):
    """An image build or verification step did not succeed."""


def snapshot_name(prefix: str, build_hash: str) -> str:
    if not SNAPSHOT_PREFIX_PATTERN.fullmatch(prefix):
        raise ImageBuildError(
            "BOXD_SNAPSHOT_PREFIX must be 1-38 lowercase letters, digits or dashes, "
            "starting with a letter or digit"
        )
    return f"{prefix}-{build_hash[:BUILD_HASH_NAME_CHARS]}"


def sandbox_vcpu() -> int:
    raw = os.environ.get("BOXD_SANDBOX_VCPU") or str(DEFAULT_SANDBOX_VCPU)
    if not raw.isdigit() or int(raw) not in SANDBOX_VCPU_CHOICES:
        raise ImageBuildError("BOXD_SANDBOX_VCPU must be 1, 2, 4 or 8")
    return int(raw)


def pack_archive(bundle_directory: Path) -> bytes:
    """A gzip tarball of the staged bundle plus this directory's boot files."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        archive.add(bundle_directory, arcname=".", recursive=True)
        for name in BOXD_FILES:
            archive.add(INFRA / name, arcname=f"boxd/{name}")
    return buffer.getvalue()


def prepare_command() -> str:
    return " && ".join(
        [
            f"sudo mkdir -p {BUNDLE_EXTRACT_DIR}",
            f"sudo tar -xzf {shlex.quote(BUNDLE_UPLOAD_PATH)} -C {BUNDLE_EXTRACT_DIR}",
        ]
    )


def install_command() -> str:
    """The shared installer, as a transient unit so it outlives this call."""
    return (
        f"sudo systemd-run --unit={INSTALL_UNIT} --property=RemainAfterExit=yes "
        f"--setenv=DEBIAN_FRONTEND=noninteractive bash {INSTALL_SCRIPT}"
    )


def finish_command() -> str:
    """Install the boot files, enable the service, and leave nothing of the build behind."""
    lines = [
        f"sudo install -D -m {mode} {BUNDLE_EXTRACT_DIR}/boxd/{name} {path}"
        for name, (path, mode) in BOXD_FILES.items()
    ]
    lines += [
        "printf '%s\\n' 'user ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-openinspect-user >/dev/null",
        "sudo chmod 0440 /etc/sudoers.d/90-openinspect-user",
        "sudo install -d -m 0700 /etc/openinspect",
        f"install -d -m 0700 {SESSION_INBOX_DIR}",
        "sudo systemctl daemon-reload",
        "sudo systemctl enable openinspect-sandbox.service",
        f"sudo systemctl stop {INSTALL_UNIT}",
        f"sudo rm -rf {BUNDLE_EXTRACT_DIR} {UPLOAD_DIR} /root/.npm /root/.cache",
        "sync",
    ]
    return " && ".join(lines)


def tail(text: str | None) -> str:
    return (text or "")[-LOG_TAIL_CHARS:]


class BoxdImageBuilder:
    def __init__(self, client: Boxd, org: str | None):
        self.client = client
        self.org = org

    def find_snapshot(self, name: str):
        from boxd.errors import NotFoundError

        try:
            return self.client.snapshots.get(name, org=self.org)
        except NotFoundError:
            return None

    def create_machine(
        self, name: str, *, from_snapshot: str | None = None, vcpu: int | None = None
    ) -> str:
        from boxd.errors import ConflictError

        # A machine restored from a snapshot has the snapshot's size.
        size = {"vcpu": vcpu, "memory": f"{vcpu * GIB_PER_VCPU}G"} if vcpu else {}
        try:
            machine = self.client.machines.create(
                name,
                from_snapshot=from_snapshot,
                org=self.org,
                isolated=True,
                labels={IMAGE_BUILD_LABEL: name},
                auto_suspend_timeout=0,
                **size,
            )
        except ConflictError as error:
            raise ImageBuildError(
                f"A boxd machine named {name} already exists, probably from an interrupted "
                "build; delete it (it carries the label openinspect/image-build) and run again"
            ) from error
        print(f"boxd machine {machine.id} ({name})", flush=True)
        self.client.machines.wait_until_ready(machine.id, timeout=READY_TIMEOUT_SECONDS)
        return machine.id

    def delete_machine(self, machine_id: str) -> None:
        from boxd.errors import NotFoundError

        with contextlib.suppress(NotFoundError):
            self.client.machines.delete(machine_id)

    def run(
        self, machine_id: str, command: str, timeout_seconds: int = STEP_TIMEOUT_SECONDS
    ) -> str:
        result = self.client.machines.exec(machine_id, command, timeout=timeout_seconds)
        if result.exit_code != 0:
            raise ImageBuildError(
                f"Command failed in {machine_id} (exit {result.exit_code}): {command}\n"
                f"{tail(result.stdout)}\n{tail(result.stderr)}"
            )
        return result.stdout

    def wait_for_install(self, machine_id: str) -> None:
        deadline = time.monotonic() + INSTALL_TIMEOUT_SECONDS
        query = f"systemctl show {INSTALL_UNIT} --property=ActiveState --property=SubState --property=ExecMainStatus"
        while True:
            state = dict(
                line.split("=", 1)
                for line in self.run(machine_id, query).splitlines()
                if "=" in line
            )
            if state.get("ActiveState") == "active" and state.get("SubState") == "exited":
                if state.get("ExecMainStatus") == "0":
                    return
                break
            if state.get("ActiveState") == "failed":
                break
            if time.monotonic() >= deadline:
                raise ImageBuildError(
                    f"Image install did not finish within {INSTALL_TIMEOUT_SECONDS}s"
                )
            time.sleep(POLL_INTERVAL_SECONDS)
        journal = self.client.machines.exec(
            machine_id, f"sudo journalctl -u {INSTALL_UNIT} --no-pager -n 200", timeout=60
        )
        raise ImageBuildError(f"Image install failed ({state}):\n{tail(journal.stdout)}")

    def wait_for_snapshot(self, name: str) -> None:
        deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
        while True:
            snapshot = self.find_snapshot(name)
            if snapshot is None:
                raise ImageBuildError(f"Snapshot {name} disappeared while saving")
            if snapshot.status == "ready":
                return
            if snapshot.status == "failed":
                raise ImageBuildError(f"Snapshot {name} failed")
            if time.monotonic() >= deadline:
                raise ImageBuildError(
                    f"Snapshot {name} not ready after {SNAPSHOT_TIMEOUT_SECONDS}s"
                )
            time.sleep(POLL_INTERVAL_SECONDS)

    def build(self, name: str, archive: bytes, vcpu: int) -> None:
        machine_id = self.create_machine(f"{name}-build", vcpu=vcpu)
        try:
            self.run(machine_id, f"mkdir -p {UPLOAD_DIR}")
            self.client.machines.files.upload(machine_id, BUNDLE_UPLOAD_PATH, archive)
            self.run(machine_id, prepare_command())
            self.run(machine_id, install_command())
            self.wait_for_install(machine_id)
            self.run(machine_id, finish_command())
            self.client.snapshots.create(machine_id, name)
            self.wait_for_snapshot(name)
            print(f"boxd snapshot {name} saved", flush=True)
        finally:
            self.delete_machine(machine_id)

    def verify(self, name: str) -> None:
        """A machine created from the snapshot boots exactly as a session machine does."""
        machine_id = self.create_machine(f"{name}-verify", from_snapshot=name)
        try:
            self.run(machine_id, "test -x /opt/openinspect/boxd/launcher.sh")
            self.run(machine_id, "systemctl is-enabled openinspect-sandbox.service")
            self.run(
                machine_id,
                f"test -d {SESSION_INBOX_DIR} && test ! -e /etc/openinspect/session.json",
            )
            self.run(machine_id, VERIFY_COMMAND, VERIFY_TIMEOUT_SECONDS)
        except Exception as error:
            raise ImageBuildError(f"boxd image verification failed: {error}") from error
        finally:
            self.delete_machine(machine_id)


def main() -> None:
    # Imported here so the tests can load this module without the SDK.
    from boxd import Boxd

    if not (os.environ.get("BOXD_API_KEY") or os.environ.get("BOXD_TOKEN")):
        raise ImageBuildError("BOXD_API_KEY is required")
    prefix = os.environ.get("BOXD_SNAPSHOT_PREFIX") or DEFAULT_SNAPSHOT_PREFIX
    bundle = pack_bundle(ROOT, "boxd", ROOT / ".cache/sandbox-images")
    name = snapshot_name(prefix, bundle.plan["buildHash"])
    builder = BoxdImageBuilder(
        Boxd(region=os.environ.get("BOXD_REGION") or None), os.environ.get("BOXD_ORG") or None
    )

    existing = builder.find_snapshot(name)
    if existing is not None and existing.status == "pending":
        builder.wait_for_snapshot(name)
    elif existing is not None and existing.status == "failed":
        raise ImageBuildError(f"Snapshot {name} exists and failed; delete it before rebuilding")
    if existing is None:
        builder.build(name, pack_archive(bundle.directory), sandbox_vcpu())
    else:
        # A retry re-verifies the retained snapshot instead of rebuilding it.
        print(f"boxd snapshot {name} already exists; verifying it", flush=True)
    builder.verify(name)
    write_build_result(name)


if __name__ == "__main__":
    main()
