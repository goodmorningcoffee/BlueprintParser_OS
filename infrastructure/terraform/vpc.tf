###############################################################################
# Beaver Infrastructure - VPC
###############################################################################

resource "aws_vpc" "beaver" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "blueprintparser-vpc"
  }
}

###############################################################################
# Internet Gateway
###############################################################################

resource "aws_internet_gateway" "beaver" {
  vpc_id = aws_vpc.beaver.id

  tags = {
    Name = "blueprintparser-igw"
  }
}

###############################################################################
# Public Subnets
###############################################################################

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.beaver.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "blueprintparser-public-${count.index + 1}"
    Tier = "public"
  }
}

###############################################################################
# Private Subnets
###############################################################################

resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.beaver.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 2)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name = "blueprintparser-private-${count.index + 1}"
    Tier = "private"
  }
}

###############################################################################
# NAT Gateway (single, in first public subnet)
###############################################################################

resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "blueprintparser-nat-eip"
  }
}

resource "aws_nat_gateway" "beaver" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "blueprintparser-nat"
  }

  depends_on = [aws_internet_gateway.beaver]
}

###############################################################################
# Route Tables - Public
###############################################################################

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.beaver.id

  tags = {
    Name = "blueprintparser-public-rt"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.beaver.id
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

###############################################################################
# Route Tables - Private
###############################################################################

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.beaver.id

  tags = {
    Name = "blueprintparser-private-rt"
  }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.beaver.id
}

resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
