# Valores não secretos ficam em production.tfvars (versionado). Os segredos
# vêm de variáveis de ambiente, nunca de arquivo no repositório:
#   HCLOUD_TOKEN                          token do projeto na Hetzner Cloud
#   TF_VAR_object_storage_access_key      credenciais do Object Storage
#   TF_VAR_object_storage_secret_key

variable "location" {
  description = "Local da Hetzner para a VM, o volume e o bucket (data residency: Alemanha)."
  type        = string
  default     = "nbg1"

  validation {
    # Locais da UE com Object Storage.
    condition     = contains(["nbg1", "fsn1", "hel1"], var.location)
    error_message = "Use um local da UE com Object Storage: nbg1, fsn1 ou hel1."
  }
}

variable "server_type" {
  description = "Tipo da VM. Confira os tipos disponíveis com `hcloud server-type list` antes do primeiro apply."
  type        = string
}

variable "server_image" {
  description = "Imagem do sistema da VM."
  type        = string
  default     = "debian-12"
}

variable "data_volume_size" {
  description = "Tamanho, em GB, do volume com os dados do Postgres e do Caddy."
  type        = number
  default     = 40

  validation {
    condition     = var.data_volume_size >= 10
    error_message = "O volume precisa de pelo menos 10 GB."
  }
}

variable "admin_ssh_public_key" {
  description = "Chave pública SSH de quem administra a VM."
  type        = string
}

variable "admin_cidrs" {
  description = "Redes que podem acessar o SSH (porta 22). Nunca 0.0.0.0/0."
  type        = list(string)

  validation {
    condition     = length(var.admin_cidrs) > 0 && alltrue([for c in var.admin_cidrs : !contains(["0.0.0.0/0", "::/0"], c)])
    error_message = "Informe ao menos uma rede de administração, sem 0.0.0.0/0 nem ::/0."
  }
}

variable "backup_bucket" {
  description = "Nome do bucket do backup do Postgres no Object Storage (único em toda a Hetzner)."
  type        = string
}

variable "object_storage_access_key" {
  description = "Chave de acesso do Object Storage (criada no console da Hetzner)."
  type        = string
  sensitive   = true
}

variable "object_storage_secret_key" {
  description = "Segredo do Object Storage (criado no console da Hetzner)."
  type        = string
  sensitive   = true
}

# Monitoramento externo (#15, ADR 0005): VM separada, em outro data center,
# para continuar avisando se a VM de produção cair inteira.
variable "monitor_location" {
  description = "Local da VM de monitoramento; diferente de `location`, para não cair junto."
  type        = string
  default     = "fsn1"

  validation {
    condition     = contains(["nbg1", "fsn1", "hel1"], var.monitor_location)
    error_message = "Use um local da UE: nbg1, fsn1 ou hel1."
  }
}

variable "monitor_server_type" {
  description = "Tipo da VM de monitoramento (a menor serve). Confira com `hcloud server-type list`."
  type        = string
}
