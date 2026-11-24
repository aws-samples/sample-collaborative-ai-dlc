output "vpc_id" {
  description = "ID of the VPC"
  value       = local.vpc_id
}

output "vpc_cidr_block" {
  description = "CIDR block of the VPC"
  value       = local.vpc_cidr_block
}

output "public_subnet_ids" {
  description = "IDs of the public subnets (empty when existing_vpc_id is set)"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets"
  value       = local.private_subnet_ids
}

output "vpc_origin_subnet_ids" {
  description = "IDs of the private subnets, available once any VPC Block Public Access exclusions exist"
  value       = local.private_subnet_ids
  depends_on = [
    aws_vpc_block_public_access_exclusion.private,
    aws_vpc_block_public_access_exclusion.nat,
  ]
}

output "internet_gateway_id" {
  description = "ID of the Internet Gateway (null when existing_vpc_id is set)"
  value       = one(aws_internet_gateway.main[*].id)
}

output "nat_gateway_ids" {
  description = "IDs of the NAT Gateways"
  value       = local.nat_gateway_ids
}

output "nat_public_ips" {
  description = "Static public IPv4 addresses used for private-subnet egress"
  value       = local.nat_public_ips
}

output "default_security_group_id" {
  description = "ID of the default security group"
  value       = aws_security_group.default.id
}

output "private_route_table_ids" {
  description = "IDs of the private route tables"
  value       = local.private_route_table_ids
}
