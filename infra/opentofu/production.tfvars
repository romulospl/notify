# Valores não secretos da produção (#14). Os segredos vêm de variáveis de
# ambiente (ver variables.tf). Ajuste antes do primeiro apply:
#   tofu -chdir=infra/opentofu apply -var-file=production.tfvars

location         = "nbg1"
server_type      = "CONFIRA: hcloud server-type list"
data_volume_size = 40
backup_bucket    = "CONFIRA: nome único, ex.: notify-backup-<sufixo>"

# Chave pública de quem administra e redes que podem entrar por SSH.
admin_ssh_public_key = "CONFIRA: ssh-ed25519 AAAA... admin@notify"
admin_cidrs          = ["CONFIRA: 203.0.113.10/32"]
