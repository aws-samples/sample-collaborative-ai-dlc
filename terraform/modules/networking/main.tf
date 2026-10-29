data "aws_availability_zones" "available" {
  state = "available"
}

# VPC
resource "aws_vpc" "main" {
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
  vpc_id = aws_vpc.main.id

  tags = {
    Name        = "${var.project_name}-${var.environment}-igw"
    Environment = var.environment
  }
}

# Public Subnets
resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
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
  count = 2

  vpc_id            = aws_vpc.main.id
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
  count = var.environment == "prod" ? 2 : 1

  domain     = "vpc"
  depends_on = [aws_internet_gateway.main]

  tags = {
    Name        = "${var.project_name}-${var.environment}-nat-eip-${count.index + 1}"
    Environment = var.environment
  }
}

# NAT Gateway
resource "aws_nat_gateway" "main" {
  count = var.environment == "prod" ? 2 : 1

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
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name        = "${var.project_name}-${var.environment}-public-rt"
    Environment = var.environment
  }
}

# Private Route Tables
resource "aws_route_table" "private" {
  count = var.environment == "prod" ? 2 : 1

  vpc_id = aws_vpc.main.id

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
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private Route Table Associations
resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = var.environment == "prod" ? aws_route_table.private[count.index].id : aws_route_table.private[0].id
}

# Default Security Group
resource "aws_security_group" "default" {
  name_prefix = "${var.project_name}-${var.environment}-default"
  description = "Default security group for the VPC; locked down by default"
  vpc_id      = aws_vpc.main.id

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
}

# CloudFront VPC origins cannot attach to subnets covered by VPC Block Public
# Access. The private subnets route only through NAT, so excluding them opens
# no internet ingress path; the ALB security group still admits CloudFront only.
resource "aws_vpc_block_public_access_exclusion" "private" {
  count = var.vpc_block_public_access_exclusion ? 2 : 0

  subnet_id                       = aws_subnet.private[count.index].id
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
