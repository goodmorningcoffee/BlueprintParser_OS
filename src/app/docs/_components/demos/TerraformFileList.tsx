import { InlineCode } from "../InlineCode";

/** Terraform files in infrastructure/terraform/ verified by `ls` against
 *  the actual repo contents. 13 files as of writing. */
const TERRAFORM_FILES = [
  { file: "main.tf", desc: "Provider + backend + top-level module wiring." },
  { file: "variables.tf", desc: "All tunable inputs (region, sizing, domain name, ACM arn, etc.)." },
  { file: "terraform.tfvars.example", desc: "Template for per-environment variable values." },
  { file: "terraform.tfvars", desc: "Actual (gitignored in most setups) per-env values." },
  { file: "outputs.tf", desc: "Exported outputs: ALB DNS, ECR repo, RDS endpoint, S3 bucket, etc." },
  { file: "vpc.tf", desc: "VPC, public and private subnets, NAT, route tables, security groups." },
  { file: "ecs.tf", desc: "ECS cluster, task defs (app / cpu-pipeline / label-studio), services, auto-scaling." },
  { file: "ecr.tf", desc: "ECR repositories for the app image and the YOLO inference image." },
  { file: "rds.tf", desc: "PostgreSQL 16 instance, subnet group, parameter group, backups." },
  { file: "s3.tf", desc: "Data bucket, CloudFront distribution with OAC, CORS, range requests." },
  { file: "iam.tf", desc: "Execution + task roles (S3, Textract, SageMaker, SFN) and Step Functions role." },
  { file: "secrets.tf", desc: "Secrets Manager entries for DATABASE_URL, NEXTAUTH_SECRET, LLM keys, etc." },
  { file: "stepfunctions.tf", desc: "State machine definition + CloudWatch log group for the processing pipeline." },
];

export function TerraformFileList() {
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-[var(--muted)] mb-2">
        <InlineCode>infrastructure/terraform/</InlineCode> &mdash; {TERRAFORM_FILES.length} files
      </div>
      <ul className="space-y-0.5">
        {TERRAFORM_FILES.map((f) => (
          <li
            key={f.file}
            className="flex flex-col md:flex-row md:items-baseline gap-1 md:gap-3 px-2 py-1.5 rounded hover:bg-[var(--surface)]/40"
          >
            <code className="font-mono text-[12px] text-[var(--accent)] w-40 shrink-0">
              {f.file}
            </code>
            <span className="text-[12px] text-[var(--fg)]/85">{f.desc}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
