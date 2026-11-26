data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  # Set existing_vpc_id to deploy into a VPC managed outside this module. No
  # VPC, subnets, gateways or route tables are created then; only the default
  # security group is, inside the given VPC.
  create_vpc = var.existing_vpc_id == null
  nat_count  = local.create_vpc ? (var.environment == "prod" ? 2 : 1) : 0

  vpc_id             = local.create_vpc ? aws_vpc.main[0].id : var.existing_vpc_id
  vpc_cidr_block     = local.create_vpc ? aws_vpc.main[0].cidr_block : data.aws_vpc.existing[0].cidr_block
  private_subnet_ids = local.create_vpc ? aws_subnet.private[*].id : var.existing_private_subnet_ids

  # An existing VPC's subnets may sit in any of its associated CIDRs.
  vpc_cidr_blocks = local.create_vpc ? [local.vpc_cidr_block] : sort(distinct([
    for association in data.aws_vpc.existing[0].cidr_block_associations :
    association.cidr_block if association.state == "associated"
  ]))

  private_route_table_ids = local.create_vpc ? aws_route_table.private[*].id : distinct([
    for id in var.existing_private_subnet_ids : data.aws_route_table.existing_private[id].id
  ])

  existing_nat_gateway_ids = local.create_vpc ? [] : sort(data.aws_nat_gateways.existing[0].ids)
  nat_gateway_ids          = local.create_vpc ? aws_nat_gateway.main[*].id : local.existing_nat_gateway_ids
  nat_public_ips = local.create_vpc ? aws_eip.nat[*].public_ip : [
    for id in local.existing_nat_gateway_ids : data.aws_nat_gateway.existing[id].public_ip
  ]
}

# Existing VPC (existing_vpc_id set)
data "aws_vpc" "existing" {
  count = local.create_vpc ? 0 : 1

  id = var.existing_vpc_id
}

# Each private subnet must have an explicit route table association.
data "aws_route_table" "existing_private" {
  for_each = local.create_vpc ? toset([]) : toset(var.existing_private_subnet_ids)

  subnet_id = each.value
}

data "aws_nat_gateways" "existing" {
  count = local.create_vpc ? 0 : 1

  vpc_id = var.existing_vpc_id

  filter {
    name   = "state"
    values = ["available"]
  }
}

data "aws_nat_gateway" "existing" {
  for_each = toset(local.existing_nat_gateway_ids)

  id = each.value
}

moved {
  from = aws_vpc.main
  to   = aws_vpc.main[0]
}

moved {
  from = aws_internet_gateway.main
  to   = aws_internet_gateway.main[0]
}

moved {
  from = aws_route_table.public
  to   = aws_route_table.public[0]
}

# VPC
resource "aws_vpc" "main" {
  count = local.create_vpc ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "${var.project_name}-${var.environment}-vpc"
    Environment = var.environment
  }
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.main[0].id

  tags = {
    Name        = "${var.project_name}-${var.environment}-igw"
    Environment = var.environment
  }
}

# Public Subnets
resource "aws_subnet" "public" {
  count = local.create_vpc ? 2 : 0

  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false

  tags = {
    Name        = "${var.project_name}-${var.environment}-public-${count.index + 1}"
    Environment = var.environment
    Type        = "public"
  }
}

# Private Subnets
resource "aws_subnet" "private" {
  count = local.create_vpc ? 2 : 0

  vpc_id            = aws_vpc.main[0].id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name        = "${var.project_name}-${var.environment}-private-${count.index + 1}"
    Environment = var.environment
    Type        = "private"
  }
}

# Elastic IP for NAT Gateway
resource "aws_eip" "nat" {
  count = local.nat_count

  domain     = "vpc"
  depends_on = [aws_internet_gateway.main]

  tags = {
    Name        = "${var.project_name}-${var.environment}-nat-eip-${count.index + 1}"
    Environment = var.environment
  }
}

# NAT Gateway
resource "aws_nat_gateway" "main" {
  count = local.nat_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name        = "${var.project_name}-${var.environment}-nat-${count.index + 1}"
    Environment = var.environment
  }

  depends_on = [aws_internet_gateway.main]
}

# Public Route Table
resource "aws_route_table" "public" {
  count = local.create_vpc ? 1 : 0

  vpc_id = aws_vpc.main[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main[0].id
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-public-rt"
    Environment = var.environment
  }
}

# Private Route Tables
resource "aws_route_table" "private" {
  count = local.nat_count

  vpc_id = aws_vpc.main[0].id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-private-rt-${count.index + 1}"
    Environment = var.environment
  }
}

# Public Route Table Associations
resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

# Private Route Table Associations
resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = var.environment == "prod" ? aws_route_table.private[count.index].id : aws_route_table.private[0].id
}

# Default Security Group
resource "aws_security_group" "default" {
  name_prefix = "${var.project_name}-${var.environment}-default"
  description = "Default security group for the VPC; locked down by default"
  vpc_id      = local.vpc_id

  egress {
    description = "Allow all egress to the internet (via NAT / VPC endpoints)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-default-sg"
    Environment = var.environment
  }

  lifecycle {
    precondition {
      condition     = local.create_vpc == (length(var.existing_private_subnet_ids) == 0)
      error_message = "existing_vpc_id and existing_private_subnet_ids must be set together."
    }
  }
}

# CloudFront VPC origins cannot attach to subnets covered by VPC Block Public
# Access. The private subnets route only through NAT, so excluding them opens
# no internet ingress path; the ALB security group still admits CloudFront only.
resource "aws_vpc_block_public_access_exclusion" "private" {
  count = var.vpc_block_public_access_exclusion ? length(local.private_subnet_ids) : 0

  subnet_id                       = local.private_subnet_ids[count.index]
  internet_gateway_exclusion_mode = "allow-bidirectional"

  tags = {
    Name        = "${var.project_name}-${var.environment}-private-${count.index + 1}-bpa-exclusion"
    Environment = var.environment
  }
}

# In bidirectional mode Block Public Access also blocks the NAT gateways, which
# the private subnets need for egress (ECR, Cognito, AgentCore). An egress-only
# exclusion on the subnets holding them keeps inbound internet traffic blocked
# and has no effect in ingress-only mode, where NAT egress is already allowed.
resource "aws_vpc_block_public_access_exclusion" "nat" {
  count = var.vpc_block_public_access_exclusion ? length(aws_nat_gateway.main) : 0

  subnet_id                       = aws_nat_gateway.main[count.index].subnet_id
  internet_gateway_exclusion_mode = "allow-egress"

  tags = {
    Name        = "${var.project_name}-${var.environment}-nat-${count.index + 1}-bpa-exclusion"
    Environment = var.environment
  }
}
