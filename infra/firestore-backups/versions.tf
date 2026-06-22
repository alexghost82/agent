terraform {
  required_version = ">= 1.5.0"

  required_providers {
    # google_firestore_backup_schedule and the Firestore export resources used
    # here are stable in recent provider releases; pin to a 5.x/6.x line.
    google = {
      source  = "hashicorp/google"
      version = ">= 5.20.0, < 7.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
