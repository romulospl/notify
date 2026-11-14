output "server_ipv4" {
  description = "IPv4 da VM: registros A de PORTAL_HOST e INGEST_HOST."
  value       = hcloud_server.notify.ipv4_address
}

output "server_ipv6" {
  description = "IPv6 da VM: registros AAAA de PORTAL_HOST e INGEST_HOST."
  value       = hcloud_server.notify.ipv6_address
}

output "data_volume_device" {
  description = "Dispositivo do volume de dados na VM (o Ansible monta em /srv/notify)."
  value       = "/dev/disk/by-id/scsi-0HC_Volume_${hcloud_volume.data.id}"
}

output "backup_s3_endpoint" {
  description = "Endpoint S3 do Object Storage, para WALG_S3_ENDPOINT."
  value       = "https://${var.location}.your-objectstorage.com"
}

output "backup_s3_prefix" {
  description = "Prefixo do WAL-G, para WALG_S3_PREFIX."
  value       = "s3://${aws_s3_bucket.backup.bucket}/postgres"
}

output "location" {
  description = "Local da Hetzner (data residency), para a documentação e o WAL-G."
  value       = var.location
}

output "monitor_ipv4" {
  description = "IPv4 da VM de monitoramento (inventário do Ansible, host `monitor`)."
  value       = hcloud_server.monitor.ipv4_address
}
