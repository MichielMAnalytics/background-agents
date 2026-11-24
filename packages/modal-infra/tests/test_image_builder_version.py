"""The Modal image builder version is pinned here, not left to the Modal environment's default."""

import typing

import modal
from modal._image import (
    ImageBuilderVersion,
)  # SDK internal: no public export lists the supported versions

from src.images import base


def test_the_pinned_builder_version_is_known_to_the_installed_client():
    assert base.IMAGE_BUILDER_VERSION in typing.get_args(ImageBuilderVersion)


def test_the_pin_applies_when_nothing_overrides_it(monkeypatch):
    monkeypatch.delenv(base.IMAGE_BUILDER_VERSION_ENV, raising=False)

    assert base.pin_image_builder_version() == base.IMAGE_BUILDER_VERSION
    # What the client reads when it builds, ahead of the Modal environment's setting.
    assert modal.config.config.get("image_builder_version") == base.IMAGE_BUILDER_VERSION


def test_an_operator_override_wins_over_the_pin(monkeypatch):
    monkeypatch.setenv(base.IMAGE_BUILDER_VERSION_ENV, "PREVIEW")

    assert base.pin_image_builder_version() == "PREVIEW"
    assert modal.config.config.get("image_builder_version") == "PREVIEW"
