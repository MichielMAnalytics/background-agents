variable "api_key" {
  description = "boxd API key. Authenticates the snapshot build and the verification restore."
  type        = string
  sensitive   = true
}

variable "region" {
  description = "Optional boxd region the build machines and the snapshot live in (e.g. fra); empty uses the key's home region"
  type        = string
  default     = ""
}

variable "org" {
  description = "Optional boxd org the build machines and the snapshot belong to and are billed to"
  type        = string
  default     = ""
}

variable "snapshot_name_prefix" {
  description = "Prefix for the immutable boxd snapshot (lowercase letters, digits, dashes)"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,45}$", var.snapshot_name_prefix))
    error_message = "snapshot_name_prefix must be 1-46 lowercase letters, digits or dashes, starting with a letter or digit."
  }
}

variable "build_size" {
  description = "boxd machine size the image is installed on. A snapshot keeps its source's size; sessions of another size are resized before they boot."
  type        = string
  default     = "2x8"

  validation {
    condition     = contains(["1x4", "2x8", "4x16", "8x32"], var.build_size)
    error_message = "build_size must be '1x4', '2x8', '4x16', or '8x32'."
  }
}

variable "deploy_path" {
  description = "Path to packages/boxd-infra"
  type        = string
}

variable "source_hash" {
  description = "Hash of source files — triggers rebuild when changed"
  type        = string
}
