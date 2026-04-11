import { TableEl } from "../TableEl";
import { InlineCode } from "../InlineCode";

/** Four-tier deployment matrix. All four tiers share the same Next.js
 *  app; the only differences are which AWS services are configured. */
export function DeploymentTierTable() {
  return (
    <TableEl
      headers={["Tier", "Requires", "Works", "Does not work"]}
      rows={[
        [
          "Local Docker",
          <span key="a">
            Docker Compose, <InlineCode>postgres:16</InlineCode>, no AWS
          </span>,
          "Upload, viewer, CSI detect, table parse (img2table/Camelot/TATR), LLM chat via Groq free tier, heuristics, QTO (manual), Bucket Fill",
          "Textract (falls back to Tesseract), SageMaker YOLO, CloudFront, S3 durability",
        ],
        [
          "Local + S3",
          <span key="b">
            AWS creds for S3, <InlineCode>S3_BUCKET</InlineCode>, rest local
          </span>,
          "Everything Local Docker does, plus durable page/thumbnail storage and cross-device viewer load",
          "Textract, SageMaker YOLO, CloudFront",
        ],
        [
          "Full AWS (CPU-only)",
          "Terraform stack: ECS, RDS, S3, CloudFront, Step Functions, Textract, Secrets Manager",
          "Production pipeline with Step Functions orchestration, Textract OCR, cached page CDN, multi-user auth, Label Studio",
          "YOLO inference (no GPU)",
        ],
        [
          "Full AWS + SageMaker",
          <span key="d">
            Add SageMaker Processing role, a YOLO ECR image, <InlineCode>sagemakerEnabled</InlineCode> toggle
          </span>,
          "All of the above plus on-demand YOLO object detection on ml.g4dn.xlarge for Auto-QTO, tag mapping, symbol search",
          "(nothing — this is the full stack)",
        ],
      ]}
    />
  );
}
