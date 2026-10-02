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

###############################################################################
# Secret-bearing ALB access logs
###############################################################################
# Label Studio must receive opaque asset capabilities in task URLs. ALB access
# logs record the complete request target, including that query bearer, before
# the application can redact it. Keep those logs available for short-horizon
# incident response, but isolate them from project data and minimize retention.
# S3 lifecycle uses whole-day granularity, so one day is the shortest supported
# age-based expiry. Expiration is asynchronous and is not an exact 24-hour SLA.

resource "aws_s3_bucket" "beaver_alb_access_logs" {
  bucket = "beaver-alb-access-logs-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name               = "beaver-alb-access-logs"
    DataClassification = "secret-bearing"
  }
}

resource "aws_s3_bucket_ownership_controls" "beaver_alb_access_logs" {
  bucket = aws_s3_bucket.beaver_alb_access_logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "beaver_alb_access_logs" {
  bucket = aws_s3_bucket.beaver_alb_access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      # Application Load Balancer access logs support SSE-S3, not SSE-KMS.
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "beaver_alb_access_logs" {
  bucket = aws_s3_bucket.beaver_alb_access_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "beaver_alb_access_logs" {
  bucket = aws_s3_bucket.beaver_alb_access_logs.id

  rule {
    id     = "expire-secret-bearing-alb-access-logs"
    status = "Enabled"

    filter {
      prefix = "alb-logs/"
    }

    expiration {
      days = 1
    }

    # No versioning is enabled for this bucket. This keeps a future accidental
    # versioning change from turning expired query-bearing logs into retained
    # noncurrent versions.
    noncurrent_version_expiration {
      noncurrent_days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "beaver_alb_access_logs" {
  bucket = aws_s3_bucket.beaver_alb_access_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # The first apply (2026-10-02) failed at ModifyLoadBalancerAttributes with "Access Denied
      # for bucket" while this statement also carried an aws:SourceAccount condition. The ALB
      # access-log doc lists aws:SourceArn (and aws:SourceOrgId) as the conditions the
      # log-delivery service principal supports, not aws:SourceAccount, so that condition is
      # gone; the account is still pinned by the account id in the resource path and the ARN.
      {
        Sid    = "AllowAccountLoadBalancerLogDelivery"
        Effect = "Allow"
        Principal = {
          Service = "logdelivery.elasticloadbalancing.amazonaws.com"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.beaver_alb_access_logs.arn}/alb-logs/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = {
          ArnLike = {
            "aws:SourceArn" = "arn:aws:elasticloadbalancing:${var.aws_region}:${data.aws_caller_identity.current.account_id}:loadbalancer/app/beaver-alb/*"
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.beaver_alb_access_logs.arn,
          "${aws_s3_bucket.beaver_alb_access_logs.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })
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

  rule {
    id     = "expire-cv-temp"
    status = "Enabled"

    filter {
      prefix = "tmp/cv-jobs/"
    }

    expiration {
      days = 1
    }
  }

  # Browser-writable project inputs are isolated from immutable project assets. Application
  # cleanup is best-effort because a presigned POST can finish after the worker's delete. Retain
  # the exact version-pinned source long enough for delayed/ambiguous worker recovery; successful
  # processing deletes it immediately, while this seven-day rule bounds abandoned transient data.
  rule {
    id     = "expire-project-upload-staging"
    status = "Enabled"

    filter {
      prefix = "_bp-staging/"
    }

    expiration {
      days = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "beaver_data" {
  bucket = aws_s3_bucket.beaver_data.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST"]
    # Only app-origin staging uploads talk to S3 from a browser. Label Studio reads opaque,
    # revocable snapshot grants through /api/label-assets and receives CORS there.
    allowed_origins = ["https://app.${var.domain_name}"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

###############################################################################
# CloudFront Response Headers Policy — retained for a future public edge protocol
###############################################################################
# The current viewer-request function returns 404 before cache lookup, so this
# policy does not serve browser assets today. Keep its explicit CORS contract
# dormant until an atomic publication/revocation protocol authorizes edge reads.

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
# CloudFront viewer gate — deny every public request until publication authority exists
###############################################################################
# A bucket-policy restriction protects origin misses, but it cannot revoke an
# object already resident in a CloudFront edge cache. This viewer-request gate
# runs before cache lookup and makes every legacy canonical/private URL fail as
# soon as the distribution configuration is deployed. The current application has
# no atomic public-prefix publication/revocation protocol, so there is deliberately
# no pass-through branch. `_bp-public/` is reserved but unused; no S3 object is
# eligible for anonymous edge delivery.

resource "aws_cloudfront_function" "beaver_public_snapshot_gate" {
  name    = "beaver-public-snapshot-gate"
  runtime = "cloudfront-js-2.0"
  comment = "Deny every viewer request; project assets use the application gateway"
  publish = true
  code    = <<-JAVASCRIPT
    function handler(event) {
      return {
        statusCode: 404,
        statusDescription: "Not Found",
        headers: {
          "cache-control": { value: "private, no-store" },
          "content-type": { value: "text/plain; charset=utf-8" },
          "x-content-type-options": { value: "nosniff" }
        },
        body: "Not found"
      };
    }
  JAVASCRIPT
}

###############################################################################
# CloudFront Origin Request Policy — retained for a future public edge protocol
###############################################################################
# The same-origin application gateway owns PDF range loading today. These
# forwarding rules are dormant behind the unconditional viewer-request 404.

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

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.beaver_public_snapshot_gate.arn
    }
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
# S3 Bucket Policy - Explicit CloudFront defense in depth, with no OAC read Allow
###############################################################################

resource "aws_s3_bucket_policy" "beaver_data" {
  bucket = aws_s3_bucket.beaver_data.id

  # First-cutover safety: Terraform must finish deploying the unconditional
  # viewer-request 404 before it can install this canonical data-bucket policy.
  depends_on = [aws_cloudfront_distribution.beaver]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # WEIGHTS-2 invariant: YOLO model weights must never be downloadable
        # over the public CDN. SageMaker reads them server-side via its IAM
        # role (a different principal), so model runs are unaffected; this only
        # revokes CloudFront's ability to serve models/* to the public. An
        # explicit Deny preserves the invariant if a future OAC Allow is added.
        Sid    = "DenyCloudFrontServingModelWeights"
        Effect = "Deny"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.beaver_data.arn}/models/*"
      },
      {
        # Browser staging contains private source documents and is never a public asset tree.
        # A future OAC policy must not make a guessed/leaked staging key CDN-readable.
        Sid    = "DenyCloudFrontServingProjectUploadStaging"
        Effect = "Deny"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.beaver_data.arn}/_bp-staging/*"
      },
      {
        # Defense in depth for server-only Lambda payloads/results. The narrow
        # deny-all viewer gate already excludes this namespace.
        Sid    = "DenyCloudFrontServingTemporaryResults"
        Effect = "Deny"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.beaver_data.arn}/tmp/*"
      },
      {
        # config/toggles.json includes authentication material and is read only
        # by the application task role.
        Sid    = "DenyCloudFrontServingConfiguration"
        Effect = "Deny"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.beaver_data.arn}/config/*"
      },
      {
        Sid    = "DenyCloudFrontServingCsiDatabases"
        Effect = "Deny"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.beaver_data.arn}/csi-databases/*"
      }
    ]
  })
}
