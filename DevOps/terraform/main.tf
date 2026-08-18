# Terraform Configuration for DevOps Platform Infrastructure
# Manages HashiCorp Vault Secrets, Policies, and Kubernetes Namespaces.

terraform {
  required_version = ">= 1.0.0"
  required_providers {
    vault = {
      source  = "hashicorp/vault"
      version = "~> 3.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

# 1. Configure the Vault Provider (connects to our port-forwarded service at localhost:8200)
provider "vault" {
  address = "http://127.0.0.1:8200"
  token   = "my-secure-token" # root token configured in Vault manifest
}

# 2. Configure the Kubernetes Provider (reads local minikube config)
provider "kubernetes" {
  config_path = "~/.kube/config"
}

# 3. Provision isolated Kubernetes namespaces using Terraform
resource "kubernetes_namespace" "devops_sandbox" {
  metadata {
    name = "ephemeral-sandbox"
    labels = {
      security = "isolated-sandbox"
      managed-by = "terraform"
    }
  }
}

# 4. Mount KV-V2 Secrets Engine inside HashiCorp Vault
resource "vault_mount" "kvv2" {
  path        = "secret"
  type        = "kv"
  options     = { version = "2" }
  description = "KeyValue Secrets Engine for DevOps Database Credentials"
}

# 5. Store preview environment credentials in Vault KV-V2
resource "vault_kv_secret_v2" "db_credentials" {
  mount = vault_mount.kvv2.path
  name  = "database/credentials"

  data_json = jsonencode({
    mongodb_url  = "mongodb://devops-mongodb-service.devops-system.svc.cluster.local:27017/preview_db"
    postgres_url = "postgresql://postgres:postgres@devops-pgvector-service.devops-system.svc.cluster.local:5432/agent_memory"
    jwt_secret   = "super-secret-preview-auth-token-key-12345"
  })
}

# 6. Define a Vault Access Policy for the DevOps Agent Node.js Backend
resource "vault_policy" "backend_policy" {
  name   = "devops-backend-policy"
  policy = <<EOT
# Read-only access to database secrets
path "secret/data/database/credentials" {
  capabilities = ["read"]
}

# Allow listing secrets
path "secret/metadata/*" {
  capabilities = ["list"]
}
EOT
}

# 7. Enable Kubernetes Authentication Backend in Vault
resource "vault_auth_backend" "kubernetes" {
  type = "kubernetes"
  path = "kubernetes"
}

# 8. Configure Vault to trust the local Kubernetes cluster service account
resource "vault_kubernetes_auth_backend_config" "k8s_config" {
  backend            = vault_auth_backend.kubernetes.path
  kubernetes_host    = "https://kubernetes.default.svc.cluster.local:443"
  # Let Vault query K8s token reviews natively
  disable_iss_validation = true
}

# 9. Bind Vault Policy to Kubernetes Service Account (for secure pod-level secret fetch)
resource "vault_kubernetes_auth_backend_role" "backend_role" {
  backend                          = vault_auth_backend.kubernetes.path
  role_name                        = "devops-backend-role"
  bound_service_account_names      = ["default"]
  bound_service_account_namespaces = ["devops-system"]
  token_policies                   = [vault_policy.backend_policy.name]
  token_ttl                        = 3600
}
