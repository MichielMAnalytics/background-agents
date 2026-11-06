"""The boxd base-snapshot builder, against a fake of the boxd Python SDK."""

import runpy
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sandbox_images import bundle, native

ROOT = Path(__file__).parents[3]
BUILDER = ROOT / "packages/boxd-infra/build-template.py"
PLAN = {
    "provider": "boxd",
    "buildHash": "a" * 64,
    "runtimeEnv": {"PACKED_PLAN": "true"},
    "runtimeVersion": "test-runtime",
    "target": {
        "os": "debian",
        "base": "ubuntu:24.04",
        "node": "24",
        "user": "boxd",
        "home": "/home/boxd",
    },
}
EXPECTED_NAME = "prefix-aaaaaaaaaaaa-123"


class NotFoundError(Exception):
    """Named like the SDK's, which the builder recognises by name."""


class FakeMachines:
    def __init__(self, sdk: "FakeBoxd") -> None:
        self.sdk = sdk
        self.files = SimpleNamespace(upload=self.upload)

    def create(self, name, **params):
        machine_id = f"m-{len(self.sdk.created) + 1}"
        self.sdk.created.append((machine_id, name, params))
        self.sdk.calls.append(("create", machine_id, params))
        return SimpleNamespace(id=machine_id, name=name, shared=self.sdk.shared_on_create)

    def get(self, machine_id):
        return SimpleNamespace(id=machine_id, status="running", shared=self.sdk.stays_shared)

    def unshare(self, machine_id):
        self.sdk.calls.append(("unshare", machine_id))

    def exec(self, machine_id, command, timeout=None):
        self.sdk.calls.append(("exec", machine_id, command))
        if command.startswith("cat ") and command.endswith("/exit 2>/dev/null || true"):
            script = self.sdk.scripts.get(machine_id, "")
            failed = self.sdk.verify_fails and script.endswith("smoke_test.py verify\n")
            return SimpleNamespace(exit_code=0, stdout="1\n" if failed else "0\n", stderr="")
        return SimpleNamespace(exit_code=0, stdout="", stderr="")

    def upload(self, machine_id, path, content):
        self.sdk.calls.append(("upload", machine_id, path, len(content)))
        if path.endswith("/step.sh"):
            self.sdk.scripts[machine_id] = content.decode()
            self.sdk.calls.append(("detached", machine_id, content.decode().strip()))
        return len(content)

    def update_labels(self, machine_id, set=None, remove=None):
        self.sdk.calls.append(("update_labels", machine_id, tuple(remove or ())))
        return {}

    def reboot(self, machine_id):
        self.sdk.calls.append(("reboot", machine_id))

    def delete(self, machine_id):
        self.sdk.calls.append(("delete", machine_id))


class FakeSnapshots:
    def __init__(self, sdk: "FakeBoxd") -> None:
        self.sdk = sdk

    def get(self, name, org=None):
        self.sdk.calls.append(("get_snapshot", name, org))
        if self.sdk.saved or self.sdk.retained_status:
            return SimpleNamespace(name=name, status=self.sdk.retained_status or "ready")
        raise NotFoundError(f"snapshot not found: {name}")

    def create(self, machine_id, name):
        self.sdk.calls.append(("create_snapshot", machine_id, name))
        self.sdk.saved = True


class FakeBoxd:
    def __init__(
        self,
        *,
        retained_status: str | None = None,
        verify_fails: bool = False,
        shared_on_create: bool = False,
        stays_shared: bool = False,
    ) -> None:
        self.retained_status = retained_status
        self.verify_fails = verify_fails
        self.shared_on_create = shared_on_create
        self.stays_shared = stays_shared
        self.saved = False
        self.calls: list[tuple] = []
        self.created: list[tuple] = []
        self.scripts: dict[str, str] = {}
        self.machines = FakeMachines(self)
        self.snapshots = FakeSnapshots(self)


@pytest.fixture
def build_mocks(monkeypatch, tmp_path):
    bundle_directory = tmp_path / "bundle"
    bundle_directory.mkdir()
    (bundle_directory / "file").write_text("x")
    monkeypatch.setattr(
        bundle, "pack_bundle", Mock(return_value=bundle.PackedBundle(bundle_directory, PLAN))
    )
    publish = Mock()
    monkeypatch.setattr(native, "write_build_result", publish)
    monkeypatch.delenv("OPENINSPECT_IMAGE_CANDIDATE", raising=False)
    monkeypatch.delenv("BOXD_BUILD_SIZE", raising=False)
    monkeypatch.delenv("BOXD_ORG", raising=False)
    monkeypatch.setattr(time, "time_ns", lambda: 123)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    monkeypatch.setenv("BOXD_API_KEY", "test-boxd-key")
    monkeypatch.setenv("BOXD_BASE_SNAPSHOT", "prefix")
    return publish


def run_builder(sdk: FakeBoxd):
    return runpy.run_path(str(BUILDER))["main"]([], sdk)


@pytest.mark.parametrize("failed", [False, True])
@pytest.mark.parametrize("retained", [False, True])
def test_boxd_retry_reuses_a_ready_snapshot(build_mocks, failed, retained):
    sdk = FakeBoxd(retained_status="ready" if retained else None, verify_fails=failed)
    if failed:
        with pytest.raises(RuntimeError, match="verification failed"):
            run_builder(sdk)
        build_mocks.assert_not_called()
    else:
        run_builder(sdk)
        build_mocks.assert_called_once_with(EXPECTED_NAME)

    names = [call[0] for call in sdk.calls]
    builds = [params for _, _, params in sdk.created if "from_snapshot" not in params]
    verifies = [
        params for _, _, params in sdk.created if params.get("from_snapshot") == EXPECTED_NAME
    ]
    assert len(builds) == (0 if retained else 1)
    assert len(verifies) == 1
    assert names.count("create_snapshot") == (0 if retained else 1)
    # Every machine the build started is deleted, on success and on failure.
    assert names.count("delete") == len(sdk.created)
    # A fresh restore prepares the launcher before the image verification.
    verify_id = next(
        machine_id for machine_id, _, params in sdk.created if "from_snapshot" in params
    )
    verify_calls = [call for call in sdk.calls if len(call) > 1 and call[1] == verify_id]
    assert (
        "exec",
        verify_id,
        "bash /home/boxd/openinspect/launcher.sh --prepare-only",
    ) in verify_calls
    detached = [call[2] for call in verify_calls if call[0] == "detached"]
    assert detached == ["sudo /opt/openinspect/python/bin/python /app/verify/smoke_test.py verify"]


def test_boxd_refuses_to_rebuild_over_a_failed_snapshot(build_mocks):
    sdk = FakeBoxd(retained_status="failed")
    with pytest.raises(RuntimeError, match="exists with status 'failed'"):
        run_builder(sdk)
    assert sdk.created == []
    assert [call[0] for call in sdk.calls] == ["get_snapshot"]
    build_mocks.assert_not_called()


def test_boxd_build_installs_reboots_then_snapshots_a_private_machine(build_mocks, monkeypatch):
    monkeypatch.setenv("BOXD_ORG", "acme")
    sdk = FakeBoxd()
    run_builder(sdk)

    build_id, build_name, build_params = sdk.created[0]
    assert build_name.startswith("oi-build-build-")
    assert build_params["vcpu"] == 2
    assert build_params["org"] == "acme" and build_params["shared"] is False
    assert all(params["isolated"] is True for _, _, params in sdk.created)
    assert "shared" not in sdk.created[1][2]
    assert build_params["delete_after"] > 0
    assert [params.get("org") for _, _, params in sdk.created] == ["acme", "acme"]
    uploads = [call[2] for call in sdk.calls if call[0] == "upload" and call[1] == build_id]
    assert uploads[:2] == [
        "/home/boxd/openinspect-image.tar.gz",
        "/home/boxd/openinspect-launcher.sh",
    ]
    detached = [call[2] for call in sdk.calls if call[0] == "detached" and call[1] == build_id]
    assert len(detached) == 1
    assert detached[0].startswith("sudo env APT_CONFIG=")
    assert detached[0].endswith("packages/sandbox-images/install/install.sh")
    commands = [call[2] for call in sdk.calls if call[0] == "exec" and call[1] == build_id]
    prepare = next(command for command in commands if "tar -xzf" in command)
    assert "/home/boxd/openinspect/launcher.sh" in prepare
    cleanup = next(command for command in commands if "rm -rf /home/boxd/.openinspect" in command)
    pin = next(command for command in commands if "chattr +i" in command)
    assert "/etc/gitconfig" in pin and "/usr/local/bin/gh" in pin
    assert commands.index(cleanup) < commands.index(pin)
    order = [call[0] for call in sdk.calls if len(call) > 1 and call[1] == build_id]
    assert order.index("detached") < order.index("reboot") < order.index("create_snapshot")
    # The files are pinned before the reboot and the save.
    pin_index = next(
        index for index, call in enumerate(sdk.calls) if call[0] == "exec" and "chattr" in call[2]
    )
    assert pin_index < sdk.calls.index(("reboot", build_id))
    assert order.index("create_snapshot") < order.index("delete")
    # Session machines inherit a snapshot's labels: the build label is gone before the save.
    assert ("update_labels", build_id, ("openinspect-image-build",)) in sdk.calls
    assert order.index("update_labels") < order.index("create_snapshot")


def test_boxd_build_size_is_validated_and_applied(build_mocks, monkeypatch):
    monkeypatch.setenv("BOXD_BUILD_SIZE", "3x12")
    with pytest.raises(RuntimeError, match="BOXD_BUILD_SIZE"):
        run_builder(FakeBoxd())
    monkeypatch.setenv("BOXD_BUILD_SIZE", "4x16")
    sdk = FakeBoxd()
    run_builder(sdk)
    assert sdk.created[0][2]["vcpu"] == 4


def test_boxd_deletes_a_machine_it_cannot_make_private(build_mocks):
    sdk = FakeBoxd(shared_on_create=True, stays_shared=True)
    with pytest.raises(RuntimeError, match="stayed shared"):
        run_builder(sdk)
    assert ("unshare", "m-1") in sdk.calls
    assert ("delete", "m-1") in sdk.calls
    assert not any(call[0] == "upload" for call in sdk.calls)


def test_boxd_candidate_name_must_be_a_valid_snapshot_name(monkeypatch):
    namespace = runpy.run_path(str(BUILDER))
    monkeypatch.delenv("OPENINSPECT_IMAGE_CANDIDATE", raising=False)
    with pytest.raises(RuntimeError, match="lowercase"):
        namespace["candidate_name"]("Open_Inspect", "a" * 64)
    monkeypatch.setenv("OPENINSPECT_IMAGE_CANDIDATE", "open-inspect-0123456789abcdef")
    assert namespace["candidate_name"]("prefix", "a" * 64) == "open-inspect-0123456789abcdef"


def test_boxd_requires_its_key_and_prefix(monkeypatch):
    monkeypatch.delenv("BOXD_API_KEY", raising=False)
    monkeypatch.setenv("BOXD_BASE_SNAPSHOT", "prefix")
    with pytest.raises(RuntimeError, match="BOXD_API_KEY"):
        runpy.run_path(str(BUILDER))["main"]([], FakeBoxd())


def test_launcher_and_provider_agree_on_the_layout():
    launcher = (ROOT / "packages/boxd-infra/launcher.sh").read_text()
    provider = (ROOT / "packages/control-plane/src/sandbox/providers/boxd-provider.ts").read_text()
    builder = BUILDER.read_text()
    assert "OI_SESSION_ENV_FILE=$OI_STATE_DIR/session.env" in launcher
    assert "OI_STATE_DIR=$OI_USER_HOME/.openinspect" in launcher
    assert "OI_USER_HOME=/home/boxd" in launcher
    assert "BOXD_SESSION_ENV_FILE_PATH = `${BOXD_STATE_DIR}/session.env`" in provider
    assert "const BOXD_STATE_DIR = `${BOXD_USER_HOME}/.openinspect`" in provider
    assert 'const BOXD_USER_HOME = "/home/boxd"' in provider
    assert "BOXD_LAUNCHER_PATH = `${BOXD_USER_HOME}/openinspect/launcher.sh`" in provider
    assert 'LAUNCHER_PATH = f"{INSTALL_HOME}/launcher.sh"' in builder
    assert 'INSTALL_HOME = f"{USER_HOME}/openinspect"' in builder
    assert "EXIT_ALREADY_RUNNING=75" in launcher
    assert "LAUNCHER_ALREADY_RUNNING_EXIT_CODE = 75" in provider
