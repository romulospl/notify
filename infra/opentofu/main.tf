provider "hcloud" {
  # Token em HCLOUD_TOKEN.
}

# O Object Storage da Hetzner fala S3; o provider da AWS só cria o bucket.
provider "aws" {
  region                      = var.location
  access_key                  = var.object_storage_access_key
  secret_key                  = var.object_storage_secret_key
  skip_credentials_validation = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true

  endpoints {
    s3 = "https://${var.location}.your-objectstorage.com"
  }
}

locals {
  labels = {
    app        = "notify"
    managed-by = "opentofu"
  }
}

resource "hcloud_ssh_key" "admin" {
  name       = "notify-admin"
  public_key = var.admin_ssh_public_key
  labels     = local.labels
}

# Só o Caddy (80 e 443) fica aberto para a internet. Postgres, Umami, portal e
# gateway não têm porta pública (infra/README.md, #62).
resource "hcloud_firewall" "notify" {
  name   = "notify"
  labels = local.labels

  rule {
    description = "SSH de administração"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.admin_cidrs
  }

  rule {
    description = "HTTP (redireciona para HTTPS e valida o certificado)"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTP/3"
    direction   = "in"
    protocol    = "udp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "Ping"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

# Dados do Postgres e do Caddy num volume separado: sobrevivem se a VM for
# recriada. O Ansible monta em /srv/notify.
resource "hcloud_volume" "data" {
  name              = "notify-data"
  size              = var.data_volume_size
  location          = var.location
  format            = "ext4"
  delete_protection = true
  labels            = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "hcloud_server" "notify" {
  name         = "notify"
  server_type  = var.server_type
  image        = var.server_image
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.notify.id]
  labels       = local.labels

  # Só o mínimo; o resto é do Ansible (infra/ansible).
  user_data = file("${path.module}/cloud-init.yaml")

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  delete_protection  = true
  rebuild_protection = true

  lifecycle {
    # Trocar o cloud-init não recria a VM: ele só roda na primeira subida.
    ignore_changes = [user_data, image, ssh_keys]
  }
}

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.notify.id
  automount = false
}

resource "aws_s3_bucket" "backup" {
  bucket = var.backup_bucket

  lifecycle {
    prevent_destroy = true
  }
}

# Monitoramento externo (#15, ADR 0005). Só SSH das redes de administração:
# Prometheus e Alertmanager escutam no loopback e são acessados por túnel.
resource "hcloud_firewall" "monitor" {
  name   = "notify-monitor"
  labels = local.labels

  rule {
    description = "SSH de administração"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.admin_cidrs
  }

  rule {
    description = "Ping"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "monitor" {
  name         = "notify-monitor"
  server_type  = var.monitor_server_type
  image        = var.server_image
  location     = var.monitor_location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.monitor.id]
  labels       = merge(local.labels, { role = "monitor" })
  user_data    = file("${path.module}/cloud-init.yaml")

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  lifecycle {
    precondition {
      condition     = var.monitor_location != var.location
      error_message = "O monitoramento precisa ficar em outro local da Hetzner, não no mesmo da produção."
    }
    ignore_changes = [user_data, image, ssh_keys]
  }
}
