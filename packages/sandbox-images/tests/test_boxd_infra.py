"""The boxd image: the launcher's environment checks and the snapshot builder's commands."""

import json
import runpy
from pathlib import Path

import pytest

INFRA = Path(__file__).resolve().parents[3] / "packages/boxd-infra"
EXEC_RUNTIME = runpy.run_path(str(INFRA / "exec-runtime.py"))
main = EXEC_RUNTIME["main"]


def write(tmp_path: Path, payload: object) -> Path:
    path = tmp_path / "session.json"
    path.write_text(json.dumps(payload))
    return path


def test_accepts_the_session_environment_the_control_plane_writes(tmp_path):
    path = write(tmp_path, {"sandboxId": "sb-1", "env": {"SANDBOX_AUTH_TOKEN": "t"}})

    assert main(["--check", str(path)]) == 0


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"sandboxId": "sb-1"},
        {"sandboxId": "", "env": {"A": "1"}},
        {"sandboxId": "sb-1", "env": {}},
        {"sandboxId": "sb-1", "env": {"A": 1}},
    ],
)
def test_refuses_anything_else_without_echoing_values(tmp_path, capsys, payload):
    path = write(tmp_path, payload)

    assert main(["--check", str(path)]) == 1
    assert "sb-1" not in capsys.readouterr().err


def test_a_rejected_file_never_echoes_its_secrets(tmp_path, capsys):
    path = write(tmp_path, {"sandboxId": "sb-1", "env": {"TOKEN": "secret-value", "N": 12345}})

    assert main(["--check", str(path)]) == 1
    error = capsys.readouterr().err
    assert "env.N" in error
    assert "secret-value" not in error
    assert "12345" not in error


def test_refuses_a_file_that_is_not_json(tmp_path):
    path = tmp_path / "session.json"
    path.write_text("<html>")

    assert main(["--check", str(path)]) == 1


def test_inbox_paths_match_the_control_plane():
    launcher = (INFRA / "launcher.sh").read_text()
    provider = (
        INFRA.parents[0] / "control-plane/src/sandbox/providers/boxd-provider.ts"
    ).read_text()
    for path in ("/home/boxd/.openinspect/session.json", "/home/boxd/.openinspect/tunnels.env"):
        assert path in launcher
        assert f'"{path}"' in provider
    assert '"sudo /opt/openinspect/boxd/launcher.sh accept"' in provider


def test_every_file_the_image_installs_exists_and_the_build_installs_it():
    builder = runpy.run_path(str(INFRA / "build-snapshot.py"), run_name="boxd_builder")
    for name, (path, _mode) in builder["BOXD_FILES"].items():
        assert (INFRA / name).is_file()
        assert path in builder["finish_command"]()
    assert "systemctl enable openinspect-sandbox.service" in builder["finish_command"]()


@pytest.mark.parametrize("prefix", ["", "Open", "-x", "a" * 39, "a_b"])
def test_snapshot_prefix_must_make_a_valid_name(prefix):
    builder = runpy.run_path(str(INFRA / "build-snapshot.py"), run_name="boxd_builder")
    with pytest.raises(builder["ImageBuildError"]):
        builder["snapshot_name"](prefix, "0" * 64)


def test_snapshot_name_carries_the_build_hash():
    builder = runpy.run_path(str(INFRA / "build-snapshot.py"), run_name="boxd_builder")
    assert builder["snapshot_name"]("openinspect-sandbox", "ab" * 32) == (
        "openinspect-sandbox-abababababababab"
    )
