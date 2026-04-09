###############################################################################
# Beaver Infrastructure - S3 + CloudFront
###############################################################################

###############################################################################
# S3 Bucket
###############################################################################

resource "aws_s3_bucket" "beaver_data" {
  bucket = "beaver-data-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "beaver-data"
  }
}

resource "aws_s3_bucket_versioning" "beaver_data" {
  bucket = aws_s3_bucket.beaver_data.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "beaver_data" {
  bucket = aws_s3_bucket.beaver_data.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "beaver_data" {
  bucket = aws_s3_bucket.beaver_data.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "beaver_data" {
  bucket = aws_s3_bucket.beaver_data.id

  rule {
    id     = "transition-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "beaver_data" {
  bucket = aws_s3_bucket.beaver_data.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    allowed_origins = ["https://app.${var.domain_name}", "https://labelstudio.${var.domain_name}"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

###############################################################################
# CloudFront Response Headers Policy — inject CORS at the edge
###############################################################################
# Fixes CORS cache poisoning: <img> tags (no Origin header) populate the cache
# without CORS headers, then fetch() requests get the cached response and fail.
# By adding CORS at the CloudFront layer, we bypass the S3 CORS caching issue.

resource "aws_cloudfront_response_headers_policy" "beaver_cors" {
  name    = "beaver-cors-policy"
  comment = "CORS headers for blueprint assets"

  cors_config {
    access_control_allow_credentials = false

    access_control_allow_headers {
      items = ["*"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }

    access_control_allow_origins {
      items = [
        "https://app.${var.domain_name}",
        "https://${var.domain_name}",
        "https://labelstudio.${var.domain_name}",
        "http://localhost:3000"
      ]
    }

    access_control_max_age_sec = 3600
    origin_override            = true
  }
}

###############################################################################
# CloudFront Origin Access Control
###############################################################################

resource "aws_cloudfront_origin_access_control" "beaver" {
  name                              = "beaver-oac"
  description                       = "OAC for Beaver S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

###############################################################################
# CloudFront Origin Request Policy — forward Range + CORS headers
###############################################################################
# Enables pdf.js range loading (HTTP 206 Partial Content) so the browser
# fetches individual pages instead of the entire PDF binary.

resource "aws_cloudfront_origin_request_policy" "beaver_range" {
  name    = "beaver-range-cors-policy"
  comment = "Forward Range + CORS headers for PDF range loading and S3 CORS"

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Origin", "Range", "Access-Control-Request-Headers", "Access-Control-Request-Method"]
    }
  }

  query_strings_config {
    query_string_behavior = "none"
  }

  cookies_config {
    cookie_behavior = "none"
  }
}

###############################################################################
# CloudFront Distribution
###############################################################################

resource "aws_cloudfront_distribution" "beaver" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Beaver data CDN"
  default_root_object = ""
  price_class         = "PriceClass_100"
  aliases             = ["assets.${var.domain_name}"]

  origin {
    domain_name              = aws_s3_bucket.beaver_data.bucket_regional_domain_name
    origin_id                = "beaver-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.beaver.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "beaver-s3"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.beaver_range.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.beaver_cors.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name = "beaver-cdn"
  }
}

###############################################################################
# S3 Bucket Policy - Allow CloudFront OAC
###############################################################################

resource "aws_s3_bucket_policy" "beaver_data" {
  bucket = aws_s3_bucket.beaver_data.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontOAC"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.beaver_data.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.beaver.arn
          }
        }
      }
    ]
  })
}
