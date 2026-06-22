# Required Google APIs. Managed here so a fresh project converges with one
# `terraform apply`. Set manage_apis=false if your org enables services out of
# band (e.g. a platform/landing-zone module already owns these).

variable "manage_apis" {
  description = "Enable the Google APIs required for backups/exports from within this module."
  type        = bool
  default     = true
}

locals {
  required_apis = [
    "firestore.googleapis.com",       # Firestore + managed backups
    "cloudscheduler.googleapis.com",  # scheduled export trigger
    "storage.googleapis.com",         # export bucket
  ]
}

resource "google_project_service" "required" {
  for_each = var.manage_apis ? toset(local.required_apis) : toset([])

  project = var.project_id
  service = each.value

  # Don't tear down shared APIs when this module is destroyed.
  disable_on_destroy = false
}
