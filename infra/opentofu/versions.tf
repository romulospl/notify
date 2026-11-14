# Produção do notify na Hetzner Cloud (#14, ADR 0004). OpenTofu, não Terraform:
# o Terraform deixou de ter licença aprovada pela OSI (BUSL), e toda
# dependência do projeto precisa ter uma.
terraform {
  required_version = ">= 1.13.2, < 2.0.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "= 1.70.2"
    }
    # Só para o bucket do backup no Object Storage da Hetzner, que fala S3.
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.71.0"
    }
  }

  # Estado local por padrão (fora do git, ver .gitignore). Para guardar o
  # estado no Object Storage, ver docs/deploy.md ("Estado do OpenTofu").
}
