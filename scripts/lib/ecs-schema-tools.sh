#!/usr/bin/env bash

bp_die() {
  echo "ERROR: $*" >&2
  return 1
}

bp_require_env() {
  local name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      bp_die "${name} is required"
      return 1
    fi
  done
}

bp_require_set() {
  local name
  for name in "$@"; do
    if [ "${!name+x}" != x ]; then
      bp_die "${name} must be explicitly set (it may be empty)"
      return 1
    fi
  done
}

bp_aws() {
  "${AWS_BIN:-aws}" "$@"
}

bp_assert_caller_account() {
  local actual
  actual=$(bp_aws sts get-caller-identity \
    --region "${AWS_REGION}" --query Account --output text) || return 1
  if [ "${actual}" != "${AWS_ACCOUNT}" ]; then
    bp_die "AWS caller account identity: expected ${AWS_ACCOUNT}, found ${actual}"
    return 1
  fi
}

bp_validate_digest() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    bp_die "expected an exact sha256 image digest, got: $1"
}

bp_expected_image_uri() {
  printf '%s.dkr.ecr.%s.amazonaws.com/%s@%s' \
    "${AWS_ACCOUNT}" "${AWS_REGION}" "${ECR_REPO}" "$1"
}

bp_service_task_definition() {
  local task_definition
  task_definition=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" \
    --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" \
    --query 'services[0].taskDefinition' \
    --output text) || return 1
  if [ -z "${task_definition}" ] || [ "${task_definition}" = "None" ]; then
    bp_die "could not resolve the app service task definition"
    return 1
  fi
  printf '%s\n' "${task_definition}"
}

bp_task_definition_image() {
  local task_definition="$1" image
  image=$(bp_aws ecs describe-task-definition \
    --task-definition "${task_definition}" \
    --region "${AWS_REGION}" \
    --query 'taskDefinition.containerDefinitions[0].image' \
    --output text) || return 1
  if [ -z "${image}" ] || [ "${image}" = "None" ]; then
    bp_die "could not resolve the image for ${task_definition}"
    return 1
  fi
  printf '%s\n' "${image}"
}

bp_latest_task_definition() {
  local family="$1"
  local arn
  arn=$(bp_aws ecs describe-task-definition \
    --task-definition "${family}" \
    --region "${AWS_REGION}" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)
  if [ -z "${arn}" ] || [ "${arn}" = "None" ]; then
    bp_die "no ACTIVE task definition found for ${family}"
    return 1
  fi
  printf '%s\n' "${arn}"
}

bp_assert_task_definition_image() {
  local family="$1"
  local expected_image="$2"
  local arn image
  arn=$(bp_latest_task_definition "${family}") || return 1
  image=$(bp_aws ecs describe-task-definition \
    --task-definition "${arn}" \
    --region "${AWS_REGION}" \
    --query 'taskDefinition.containerDefinitions[0].image' \
    --output text)
  if [ "${image}" != "${expected_image}" ]; then
    bp_die "${family} latest revision uses ${image}, expected ${expected_image}; apply Terraform with TF_VAR_beaver_app_image_digest first"
    return 1
  fi
  case "${image}" in
    *:latest) bp_die "${family} still uses the mutable latest tag"; return 1 ;;
  esac
  printf '%s\n' "${arn}"
}

bp_task_definition_environment_value() {
  local task_definition="$1"
  local environment_name="$2"
  if [[ ! "${environment_name}" =~ ^[A-Z0-9_]+$ ]]; then
    bp_die "invalid task-definition environment key: ${environment_name}"
    return 1
  fi
  local value
  value=$(bp_aws ecs describe-task-definition \
    --task-definition "${task_definition}" \
    --region "${AWS_REGION}" \
    --query "taskDefinition.containerDefinitions[0].environment[?name=='${environment_name}'].value | [0]" \
    --output text)
  if [ -z "${value}" ] || [ "${value}" = "None" ]; then
    bp_die "${task_definition} does not declare ${environment_name}"
    return 1
  fi
  printf '%s\n' "${value}"
}

bp_assert_task_definition_contract() {
  local task_definition="$1" role="$2"
  local definition
  definition=$(bp_aws ecs describe-task-definition \
    --task-definition "${task_definition}" \
    --region "${AWS_REGION}" \
    --query taskDefinition \
    --output json) || return 1
  printf '%s' "${definition}" | node -e '
let input = "";
const role = process.argv[1];
const account = process.argv[2];
const region = process.argv[3];
const domain = process.argv[4];
const cloudFrontDistributionId = process.argv[5];
const rootAdminEmail = process.argv[6];
const dataBucket = `beaver-data-${account}`;
const cloudFrontDomain = `assets.${domain}`;
const labelStudioUrl = `https://labelstudio.${domain}`;
const appUrl = `https://app.${domain}`;
const stepFunctionArn = `arn:aws:states:${region}:${account}:stateMachine:beaver-process-blueprint`;
const sagemakerRoleArn = `arn:aws:iam::${account}:role/beaver-sagemaker-role`;
const projectAssetEventQueueUrl = `https://sqs.${region}.amazonaws.com/${account}/beaver-project-asset-events`;
const contracts = {
  app: {
    name: "beaver-app",
    command: [],
    environment: ["AWS_ACCOUNT", "AWS_REGION", "CLOUDFRONT_DISTRIBUTION_ID", "CLOUDFRONT_DOMAIN", "LABEL_STUDIO_INSTANCE_ID", "LABEL_STUDIO_URL", "LAMBDA_CV_ENABLED", "LAMBDA_CV_FUNCTION_NAME", "NEXTAUTH_URL", "NODE_ENV", "PORT", "ROOT_ADMIN_EMAIL", "S3_BUCKET", "SAGEMAKER_ROLE_ARN", "STEP_FUNCTION_ARN", "YOLO_ECR_IMAGE"],
    secrets: ["ANTHROPIC_API_KEY", "DATABASE_URL", "GROQ_API_KEY", "LABEL_STUDIO_API_KEY", "NEXTAUTH_SECRET", "PROCESSING_WEBHOOK_SECRET"],
    taskRole: "beaver-ecs-task-role",
    logGroup: "/ecs/blueprintparser-app",
    logPrefix: "beaver",
    healthCheck: { command: ["CMD-SHELL", "curl -f http://localhost:3000/api/health || exit 1"], interval: 30, timeout: 5, retries: 3, startPeriod: 60 },
  },
  cpu: {
    name: "beaver-cpu-pipeline",
    command: ["./entrypoint.sh", "worker", "node", "scripts/process-worker.js"],
    environment: ["AWS_REGION", "CLOUDFRONT_DOMAIN", "NODE_ENV", "S3_BUCKET"],
    secrets: ["DATABASE_URL"],
    taskRole: "beaver-ecs-task-role",
    logGroup: "/ecs/blueprintparser-cpu-pipeline",
    logPrefix: "cpu-pipeline",
  },
  maintenance: {
    name: "beaver-project-asset-deletions",
    command: ["./entrypoint.sh", "worker", "node", "scripts/project-asset-deletion-worker.js"],
    environment: ["AWS_REGION", "CLOUDFRONT_DISTRIBUTION_ID", "CLOUDFRONT_DOMAIN", "LABEL_STUDIO_INSTANCE_ID", "LABEL_STUDIO_URL", "NODE_ENV", "PROJECT_ASSET_EVENT_QUEUE_URL", "S3_BUCKET"],
    secrets: ["DATABASE_URL", "LABEL_STUDIO_API_KEY"],
    taskRole: "beaver-project-asset-deletion-task-role",
    logGroup: "/ecs/blueprintparser-project-asset-deletions",
    logPrefix: "project-asset-deletions",
  },
  migrator: {
    name: "beaver-schema-migrator",
    command: ["./entrypoint.sh", "migrate"],
    environment: ["NODE_ENV"],
    secrets: ["DATABASE_URL"],
    taskRole: "beaver-schema-migrator-task-role",
    logGroup: "/ecs/blueprintparser-schema-migrator",
    logPrefix: "schema-migrator",
  },
};
const expectedEnvironment = {
  app: {
    AWS_ACCOUNT: account,
    AWS_REGION: region,
    CLOUDFRONT_DISTRIBUTION_ID: cloudFrontDistributionId,
    CLOUDFRONT_DOMAIN: cloudFrontDomain,
    LABEL_STUDIO_URL: labelStudioUrl,
    LAMBDA_CV_ENABLED: "true",
    LAMBDA_CV_FUNCTION_NAME: "beaver-cv-pipeline",
    NEXTAUTH_URL: appUrl,
    NODE_ENV: "production",
    PORT: "3000",
    ROOT_ADMIN_EMAIL: rootAdminEmail,
    S3_BUCKET: dataBucket,
    SAGEMAKER_ROLE_ARN: sagemakerRoleArn,
    STEP_FUNCTION_ARN: stepFunctionArn,
  },
  cpu: {
    AWS_REGION: region,
    CLOUDFRONT_DOMAIN: cloudFrontDomain,
    NODE_ENV: "production",
    S3_BUCKET: dataBucket,
  },
  maintenance: {
    AWS_REGION: region,
    CLOUDFRONT_DISTRIBUTION_ID: cloudFrontDistributionId,
    CLOUDFRONT_DOMAIN: cloudFrontDomain,
    LABEL_STUDIO_URL: labelStudioUrl,
    NODE_ENV: "production",
    PROJECT_ASSET_EVENT_QUEUE_URL: projectAssetEventQueueUrl,
    S3_BUCKET: dataBucket,
  },
  migrator: { NODE_ENV: "production" },
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const task = JSON.parse(input);
    const contract = contracts[role];
    const containers = task?.containerDefinitions;
    if (!contract || !Array.isArray(containers) || containers.length !== 1) {
      console.error(`invalid role/container count for ${role}`);
      process.exit(2);
    }
    const container = containers[0];
    const command = container.command ?? [];
    const environment = container.environment ?? [];
    const secrets = container.secrets ?? [];
    const environmentNames = environment.map((entry) => entry.name);
    const environmentValues = new Map(environment.map((entry) => [entry.name, entry.value]));
    const secretNames = secrets.map((entry) => entry.name);
    const databaseSecrets = secrets.filter((entry) => entry.name === "DATABASE_URL");
    const nodeEnvironments = environment.filter((entry) => entry.name === "NODE_ENV");
    const secret = databaseSecrets[0];
    const nodeEnv = nodeEnvironments[0]?.value;
    const armed = environment.some((entry) => entry.name === "BP_SCHEMA_MIGRATION_MODE");
    const failures = [];
    const expectedExecutionRole = `arn:aws:iam::${account}:role/beaver-ecs-execution-role`;
    const expectedTaskRole = `arn:aws:iam::${account}:role/${contract?.taskRole}`;
    const sortedEnvironmentNames = [...environmentNames].sort();
    const sortedSecretNames = [...secretNames].sort();
    if (task?.family !== contract?.name) failures.push("family");
    if (task?.networkMode !== "awsvpc") failures.push("network mode");
    if (JSON.stringify(task?.requiresCompatibilities) !== JSON.stringify(["FARGATE"])) failures.push("Fargate compatibility");
    if (task?.executionRoleArn !== expectedExecutionRole) failures.push("execution role");
    if (task?.taskRoleArn !== expectedTaskRole) failures.push("task role");
    const runtimePlatform = task?.runtimePlatform;
    if (
      runtimePlatform == null ||
      Object.keys(runtimePlatform).sort().join("\0") !== ["cpuArchitecture", "operatingSystemFamily"].join("\0") ||
      runtimePlatform.cpuArchitecture !== "X86_64" ||
      runtimePlatform.operatingSystemFamily !== "LINUX"
    ) failures.push("runtime platform");
    if (Array.isArray(task?.volumes) ? task.volumes.length !== 0 : task?.volumes != null) failures.push("task volumes");
    if (task?.proxyConfiguration != null) failures.push("proxy configuration");
    if (container.name !== contract.name) failures.push("container name");
    if (container.essential !== true) failures.push("essential flag");
    if (JSON.stringify(command) !== JSON.stringify(contract.command)) failures.push("command");
    if (Array.isArray(container.entryPoint) && container.entryPoint.length > 0) failures.push("entryPoint");
    if (JSON.stringify(sortedEnvironmentNames) !== JSON.stringify(contract.environment)) failures.push("environment allowlist");
    if (JSON.stringify(sortedSecretNames) !== JSON.stringify(contract.secrets)) failures.push("secret allowlist");
    if (new Set(environmentNames).size !== environmentNames.length) failures.push("duplicate environment names");
    if (new Set(secretNames).size !== secretNames.length) failures.push("duplicate secret names");
    const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
    if (
      !domainPattern.test(domain) ||
      !/^[A-Z0-9]{10,32}$/u.test(cloudFrontDistributionId) ||
      (rootAdminEmail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(rootAdminEmail))
    ) failures.push("deployment contract input");
    for (const [name, expectedValue] of Object.entries(expectedEnvironment[role] ?? {})) {
      if (environmentValues.get(name) !== expectedValue) failures.push(`${name} value`);
    }
    for (const name of role === "app" || role === "maintenance" ? ["LABEL_STUDIO_INSTANCE_ID"] : []) {
      if (!/^fs-(?:[0-9a-f]{8}|[0-9a-f]{17}):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(environmentValues.get(name) ?? "")) {
        failures.push(`${name} value`);
      }
    }
    if (role === "app") {
      const expectedYoloPrefix = `${account}.dkr.ecr.${region}.amazonaws.com/beaver-yolo-pipeline@`;
      const yoloImage = environmentValues.get("YOLO_ECR_IMAGE");
      if (
        typeof yoloImage !== "string" ||
        !yoloImage.startsWith(expectedYoloPrefix) ||
        !/^sha256:[0-9a-f]{64}$/u.test(yoloImage.slice(expectedYoloPrefix.length))
      ) failures.push("YOLO_ECR_IMAGE value");
    }
    if (databaseSecrets.length !== 1 || environmentNames.includes("DATABASE_URL")) failures.push("DATABASE_URL authority");
    if (nodeEnvironments.length !== 1 || secretNames.includes("NODE_ENV")) failures.push("NODE_ENV authority");
    if (Array.isArray(container.environmentFiles) && container.environmentFiles.length > 0) failures.push("environmentFiles");
    if (Array.isArray(container.mountPoints) ? container.mountPoints.length !== 0 : container.mountPoints != null) failures.push("mountPoints");
    if (Array.isArray(container.volumesFrom) ? container.volumesFrom.length !== 0 : container.volumesFrom != null) failures.push("volumesFrom");
    if (container.linuxParameters != null) failures.push("linuxParameters");
    if (container.workingDirectory != null) failures.push("workingDirectory");
    if (container.user != null) failures.push("user");
    if (container.privileged != null) failures.push("privileged");
    if (Array.isArray(container.extraHosts) ? container.extraHosts.length !== 0 : container.extraHosts != null) failures.push("extraHosts");
    if (container.repositoryCredentials != null) failures.push("repository credentials");
    if (Array.isArray(container.dnsServers) ? container.dnsServers.length !== 0 : container.dnsServers != null) failures.push("dnsServers");
    if (Array.isArray(container.dnsSearchDomains) ? container.dnsSearchDomains.length !== 0 : container.dnsSearchDomains != null) failures.push("dnsSearchDomains");
    if (container.hostname != null) failures.push("hostname");
    if (container.firelensConfiguration != null) failures.push("firelensConfiguration");
    if (container.restartPolicy != null) failures.push("restartPolicy");
    if (Array.isArray(container.dockerSecurityOptions) ? container.dockerSecurityOptions.length !== 0 : container.dockerSecurityOptions != null) failures.push("dockerSecurityOptions");
    if (Array.isArray(container.systemControls) ? container.systemControls.length !== 0 : container.systemControls != null) failures.push("systemControls");
    const logOptions = container.logConfiguration?.options;
    const expectedLogOptionNames = ["awslogs-group", "awslogs-region", "awslogs-stream-prefix"];
    if (
      container.logConfiguration?.logDriver !== "awslogs" ||
      logOptions == null ||
      Object.keys(logOptions).sort().join("\0") !== expectedLogOptionNames.join("\0") ||
      logOptions["awslogs-group"] !== contract.logGroup ||
      logOptions["awslogs-region"] !== region ||
      logOptions["awslogs-stream-prefix"] !== contract.logPrefix ||
      (Array.isArray(container.logConfiguration?.secretOptions)
        ? container.logConfiguration.secretOptions.length !== 0
        : container.logConfiguration?.secretOptions != null)
    ) failures.push("log configuration");
    const secretPath = {
      NEXTAUTH_SECRET: "NEXTAUTH_SECRET",
      PROCESSING_WEBHOOK_SECRET: "PROCESSING_WEBHOOK_SECRET",
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      GROQ_API_KEY: "GROQ_API_KEY",
      LABEL_STUDIO_API_KEY: "LABEL_STUDIO_API_KEY",
    };
    for (const candidate of secrets) {
      if (candidate.name === "DATABASE_URL") continue;
      const path = secretPath[candidate.name];
      const expected = new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:beaver/${path}-[A-Za-z0-9]{6}$`);
      if (!path || typeof candidate.valueFrom !== "string" || !expected.test(candidate.valueFrom)) {
        failures.push(`${candidate.name} secret identity`);
      }
    }
    if (role === "app") {
      const healthCheck = container.healthCheck;
      if (
        healthCheck == null ||
        Object.keys(healthCheck).sort().join("\0") !== ["command", "interval", "retries", "startPeriod", "timeout"].join("\0") ||
        JSON.stringify(healthCheck.command) !== JSON.stringify(contract.healthCheck.command) ||
        healthCheck.interval !== contract.healthCheck.interval ||
        healthCheck.timeout !== contract.healthCheck.timeout ||
        healthCheck.retries !== contract.healthCheck.retries ||
        healthCheck.startPeriod !== contract.healthCheck.startPeriod
      ) failures.push("healthCheck");
    } else if (container.healthCheck != null) failures.push("healthCheck");
    if (!secret?.valueFrom) failures.push("DATABASE_URL secret");
    if (
      typeof secret?.valueFrom !== "string" ||
      !/^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[^:]+:::[A-Za-z0-9-]{32,64}$/.test(secret.valueFrom)
    ) failures.push("DATABASE_URL version selector");
    if (nodeEnv !== "production") failures.push("NODE_ENV");
    if (armed || secretNames.includes("BP_SCHEMA_MIGRATION_MODE")) failures.push("armed migration mode");
    if (failures.length > 0) {
      console.error(`contract fields: ${failures.join(", ")}`);
      process.exit(2);
    }
    process.stdout.write(`${secret.valueFrom}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
});
' "${role}" "${AWS_ACCOUNT}" "${AWS_REGION}" "${DOMAIN:-}" "${CLOUDFRONT_DISTRIBUTION_ID:-}" "${ROOT_ADMIN_EMAIL:-}" || {
    bp_die "${task_definition} violates the ${role} task-definition contract"
    return 1
  }
}

bp_assert_task_role_has_no_permissions() {
  local role_name="$1" inline_policies attached_policies
  inline_policies=$(bp_aws iam list-role-policies \
    --role-name "${role_name}" \
    --region "${AWS_REGION}" \
    --query PolicyNames \
    --output json) || return 1
  attached_policies=$(bp_aws iam list-attached-role-policies \
    --role-name "${role_name}" \
    --region "${AWS_REGION}" \
    --query AttachedPolicies \
    --output json) || return 1
  if ! node -e '
const [inlineJson, attachedJson] = process.argv.slice(1);
const inlinePolicies = JSON.parse(inlineJson);
const attachedPolicies = JSON.parse(attachedJson);
if (
  !Array.isArray(inlinePolicies) ||
  inlinePolicies.length !== 0 ||
  !Array.isArray(attachedPolicies) ||
  attachedPolicies.length !== 0
) process.exit(2);
' "${inline_policies}" "${attached_policies}"; then
    bp_die "${role_name} must have no inline or attached permission policies"
    return 1
  fi
}

bp_task_definition_label_studio_identity() {
  local task_definition="$1"
  local definition
  definition=$(bp_aws ecs describe-task-definition \
    --task-definition "${task_definition}" \
    --region "${AWS_REGION}" \
    --query taskDefinition \
    --output json) || return 1
  printf '%s' "${definition}" | node -e '
let input = "";
const [account, region] = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const task = JSON.parse(input);
    const container = task?.containerDefinitions?.[0];
    const environment = container?.environment ?? [];
    const secrets = container?.secrets ?? [];
    const urls = environment.filter((entry) => entry?.name === "LABEL_STUDIO_URL");
    const instances = environment.filter((entry) => entry?.name === "LABEL_STUDIO_INSTANCE_ID");
    const apiSecrets = secrets.filter((entry) => entry?.name === "LABEL_STUDIO_API_KEY");
    if (urls.length !== 1 || instances.length !== 1 || apiSecrets.length !== 1) process.exit(2);
    const urlValue = urls[0]?.value;
    const instanceValue = instances[0]?.value;
    const secretValueFrom = apiSecrets[0]?.valueFrom;
    const url = new URL(urlValue);
    const expectedSecret = new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:beaver/LABEL_STUDIO_API_KEY-[A-Za-z0-9]{6}$`);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      urlValue !== `https://${url.hostname}` ||
      !/^labelstudio\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(url.hostname) ||
      !/^fs-(?:[0-9a-f]{8}|[0-9a-f]{17}):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(instanceValue) ||
      typeof secretValueFrom !== "string" ||
      !expectedSecret.test(secretValueFrom)
    ) process.exit(2);
    process.stdout.write(`${urlValue}\t${instanceValue}\t${secretValueFrom}\n`);
  } catch {
    process.exit(2);
  }
});
' "${AWS_ACCOUNT}" "${AWS_REGION}" || {
    bp_die "${task_definition} violates the Label Studio provider identity contract"
    return 1
  }
}

bp_assert_database_secret_identity() {
  local selector="$1" secret_arn version_id secret_metadata rds_metadata
  local endpoint port database_name master_username
  if [[ ! "${selector}" =~ ^(arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[^:]+):::([A-Za-z0-9-]{32,64})$ ]]; then
    bp_die "DATABASE_URL must use an exact base-ARN:::version-id selector"
    return 1
  fi
  secret_arn="${BASH_REMATCH[1]}"
  version_id="${BASH_REMATCH[2]}"
  # DescribeSecret omits RotationEnabled entirely for a secret that was never configured for
  # rotation (the API returns null), which is every secret Terraform creates here. Reject only an
  # explicit `true`; `!== false` refused every real deployment before it touched anything.
  secret_metadata=$(bp_aws secretsmanager describe-secret \
    --secret-id beaver/DATABASE_URL \
    --region "${AWS_REGION}" --output json) || return 1
  if ! printf '%s' "${secret_metadata}" | node -e '
let input = "";
const [expectedArn, expectedVersion, expectedRegion, expectedAccount] = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const secret = JSON.parse(input);
    const expectedPrefix = `arn:aws:secretsmanager:${expectedRegion}:${expectedAccount}:secret:beaver/DATABASE_URL-`;
    if (
      secret?.ARN !== expectedArn ||
      !secret.ARN.startsWith(expectedPrefix) ||
      secret.ARN.length !== expectedPrefix.length + 6 ||
      secret?.Name !== "beaver/DATABASE_URL" ||
      secret?.RotationEnabled === true ||
      secret?.DeletedDate !== undefined ||
      !Array.isArray(secret?.VersionIdsToStages?.[expectedVersion]) ||
      !secret.VersionIdsToStages[expectedVersion].includes("AWSCURRENT")
    ) process.exit(2);
  } catch {
    process.exit(2);
  }
});
' "${secret_arn}" "${version_id}" "${AWS_REGION}" "${AWS_ACCOUNT}"; then
    bp_die "canonical DATABASE_URL secret metadata validation failed"
    return 1
  fi

  rds_metadata=$(bp_aws rds describe-db-instances \
    --db-instance-identifier beaver-db --region "${AWS_REGION}" \
    --output json) || return 1
  if ! rds_metadata=$(printf '%s' "${rds_metadata}" | node -e '
let input = "";
const [expectedRegion, expectedAccount] = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const response = JSON.parse(input);
    const instances = response?.DBInstances;
    const instance = instances?.[0];
    const endpoint = instance?.Endpoint;
    if (
      !Array.isArray(instances) ||
      instances.length !== 1 ||
      instance?.DBInstanceIdentifier !== "beaver-db" ||
      instance?.DBInstanceArn !== `arn:aws:rds:${expectedRegion}:${expectedAccount}:db:beaver-db` ||
      instance?.Engine !== "postgres" ||
      instance?.DBInstanceStatus !== "available" ||
      instance?.DBName !== "beaver" ||
      instance?.PubliclyAccessible !== false ||
      typeof instance?.MasterUsername !== "string" ||
      instance.MasterUsername.length === 0 ||
      !/^beaver-db\.[a-z0-9-]+\.[a-z0-9-]+\.rds\.amazonaws\.com$/u.test(endpoint?.Address) ||
      endpoint?.Port !== 5432
    ) process.exit(2);
    process.stdout.write([endpoint.Address, endpoint.Port, instance.DBName, instance.MasterUsername].join("\t"));
  } catch {
    process.exit(2);
  }
});
' "${AWS_REGION}" "${AWS_ACCOUNT}"); then
    bp_die "canonical beaver-db metadata validation failed"
    return 1
  fi
  IFS=$'\t' read -r endpoint port database_name master_username <<<"${rds_metadata}"

  # Stream the secret directly into a validator. Never place the URL in shell
  # argv, a command substitution, logs, or a temporary file.
  if ! bp_aws secretsmanager get-secret-value \
    --secret-id "${secret_arn}" \
    --version-id "${version_id}" \
    --version-stage AWSCURRENT \
    --region "${AWS_REGION}" \
    --query SecretString \
    --output text | node -e '
let input = "";
const [expectedHost, expectedPort, expectedDatabase, expectedUsername] = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const secret = input.replace(/\r?\n$/u, "");
    const url = new URL(secret);
    const formDecode = (value) => decodeURIComponent(value.replace(/\+/gu, " "));
    const database = formDecode(url.pathname.slice(1));
    const username = formDecode(url.username);
    const password = formDecode(url.password);
    if (!/^beaver-db\.[a-z0-9-]+\.[a-z0-9-]+\.rds\.amazonaws\.com$/u.test(expectedHost)) throw new Error("non-canonical RDS endpoint");
    if (expectedPort !== "5432" || expectedDatabase !== "beaver") throw new Error("non-canonical RDS metadata");
    if (url.protocol !== "postgresql:") throw new Error("protocol");
    if (url.hostname !== expectedHost || url.port !== expectedPort) throw new Error("endpoint");
    if (database !== expectedDatabase || !url.pathname.startsWith("/") || database.includes("/")) throw new Error("database");
    if (username !== expectedUsername || password.length === 0) throw new Error("credentials");
    if (url.search !== "" || url.hash !== "") throw new Error("URL overrides");
  } catch {
    console.error("DATABASE_URL identity validation failed");
    process.exit(2);
  }
});
' "${endpoint}" "${port}" "${database_name}" "${master_username}"; then
    bp_die "the pinned AWSCURRENT DATABASE_URL identity validation failed"
    return 1
  fi
}

bp_state_machine_cpu_target() {
  local definition
  definition=$(bp_aws stepfunctions describe-state-machine \
    --state-machine-arn "${STEP_FUNCTION_ARN}" \
    --region "${AWS_REGION}" \
    --query definition \
    --output text) || return 1
  printf '%s' "${definition}" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const definition = JSON.parse(input);
    const states = definition?.States;
    const validateInput = states?.ValidateInput;
    const state = states?.CPUProcessing;
    const processingComplete = states?.ProcessingComplete;
    const processingFailed = states?.ProcessingFailed;
    const parameters = state?.Parameters;
    const taskDefinition = parameters?.TaskDefinition;
    const cluster = parameters?.Cluster;
    const platformVersion = parameters?.PlatformVersion;
    const overrides = parameters?.Overrides;
    const containerOverrides = overrides?.ContainerOverrides;
    const containerOverride = containerOverrides?.[0];
    const environment = containerOverride?.Environment;
    const network = parameters?.NetworkConfiguration;
    const awsvpc = network?.AwsvpcConfiguration;
    const retry = state?.Retry;
    const retryRule = retry?.[0];
    const catches = state?.Catch;
    const catchRule = catches?.[0];
    const exactKeys = (value, expected) =>
      value != null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
    const expectedEnvironment = {
      DATA_URL: "$.dataUrl",
      // This JavaScript sits inside a bash single-quoted node -e block, so a bare apostrophe
      // would end the shell string and node would compare against States.Format({}, ...), which
      // never matches what Terraform emits. \u0027 is a quote to JavaScript and inert to bash.
      PROJECT_ID: "States.Format(\u0027{}\u0027, $.projectId)",
      S3_BUCKET: "$.s3Bucket",
      WEBHOOK_SECRET: "$.webhookSecret",
      WEBHOOK_URL: "$.webhookUrl",
    };
    const actualEnvironmentNames = Array.isArray(environment)
      ? environment.map((entry) => entry?.Name).sort()
      : [];
    if (
      !exactKeys(definition, ["Comment", "StartAt", "States"]) ||
      definition.Comment !== "Beaver blueprint processing pipeline" ||
      definition.StartAt !== "ValidateInput" ||
      !exactKeys(states, ["CPUProcessing", "ProcessingComplete", "ProcessingFailed", "ValidateInput"]) ||
      !exactKeys(validateInput, ["Next", "Parameters", "Type"]) ||
      validateInput.Type !== "Pass" ||
      validateInput.Next !== "CPUProcessing" ||
      !exactKeys(validateInput.Parameters, ["dataUrl.$", "projectId.$", "s3Bucket.$", "status", "webhookSecret.$", "webhookUrl.$"]) ||
      validateInput.Parameters["projectId.$"] !== "$.projectId" ||
      validateInput.Parameters["dataUrl.$"] !== "$.dataUrl" ||
      validateInput.Parameters["s3Bucket.$"] !== "$.s3Bucket" ||
      validateInput.Parameters["webhookUrl.$"] !== "$.webhookUrl" ||
      validateInput.Parameters["webhookSecret.$"] !== "$.webhookSecret" ||
      validateInput.Parameters.status !== "PROCESSING" ||
      !exactKeys(state, ["Catch", "Next", "Parameters", "Resource", "ResultPath", "Retry", "Type"]) ||
      state.Type !== "Task" ||
      state.Resource !== "arn:aws:states:::ecs:runTask.sync" ||
      state.ResultPath !== "$.cpuResult" ||
      state.Next !== "ProcessingComplete" ||
      !exactKeys(parameters, ["Cluster", "LaunchType", "NetworkConfiguration", "Overrides", "PlatformVersion", "TaskDefinition"]) ||
      typeof taskDefinition !== "string" ||
      typeof cluster !== "string" ||
      parameters.LaunchType !== "FARGATE" ||
      platformVersion !== "1.4.0" ||
      !exactKeys(network, ["AwsvpcConfiguration"]) ||
      !exactKeys(awsvpc, ["AssignPublicIp", "SecurityGroups", "Subnets"]) ||
      awsvpc.AssignPublicIp !== "DISABLED" ||
      !Array.isArray(awsvpc.Subnets) ||
      awsvpc.Subnets.length === 0 ||
      awsvpc.Subnets.some((subnet) => typeof subnet !== "string" || !subnet.startsWith("subnet-")) ||
      new Set(awsvpc.Subnets).size !== awsvpc.Subnets.length ||
      !Array.isArray(awsvpc.SecurityGroups) ||
      awsvpc.SecurityGroups.length !== 1 ||
      typeof awsvpc.SecurityGroups[0] !== "string" ||
      !awsvpc.SecurityGroups[0].startsWith("sg-") ||
      !exactKeys(overrides, ["ContainerOverrides"]) ||
      !Array.isArray(containerOverrides) ||
      containerOverrides.length !== 1 ||
      !exactKeys(containerOverride, ["Environment", "Name"]) ||
      containerOverride.Name !== "beaver-cpu-pipeline" ||
      !Array.isArray(environment) ||
      environment.length !== Object.keys(expectedEnvironment).length ||
      new Set(actualEnvironmentNames).size !== actualEnvironmentNames.length ||
      JSON.stringify(actualEnvironmentNames) !== JSON.stringify(Object.keys(expectedEnvironment).sort()) ||
      environment.some(
        (entry) =>
          !exactKeys(entry, ["Name", "Value.$"]) ||
          entry["Value.$"] !== expectedEnvironment[entry.Name],
      ) ||
      !Array.isArray(retry) ||
      retry.length !== 1 ||
      !exactKeys(retryRule, ["BackoffRate", "ErrorEquals", "IntervalSeconds", "MaxAttempts"]) ||
      JSON.stringify(retryRule.ErrorEquals) !== JSON.stringify(["States.TaskFailed"]) ||
      retryRule.IntervalSeconds !== 30 ||
      retryRule.MaxAttempts !== 2 ||
      retryRule.BackoffRate !== 2 ||
      !Array.isArray(catches) ||
      catches.length !== 1 ||
      !exactKeys(catchRule, ["ErrorEquals", "Next", "ResultPath"]) ||
      JSON.stringify(catchRule.ErrorEquals) !== JSON.stringify(["States.ALL"]) ||
      catchRule.Next !== "ProcessingFailed" ||
      catchRule.ResultPath !== "$.error" ||
      !exactKeys(processingComplete, ["Type"]) ||
      processingComplete.Type !== "Succeed" ||
      !exactKeys(processingFailed, ["Cause", "Error", "Type"]) ||
      processingFailed.Type !== "Fail" ||
      processingFailed.Error !== "ProcessingFailed" ||
      processingFailed.Cause !== "Blueprint processing pipeline failed. Check CloudWatch logs for details."
    ) process.exit(2);
    process.stdout.write(`${taskDefinition}\t${cluster}\n`);
  } catch {
    process.exit(2);
  }
});
' || {
    bp_die "could not resolve CPUProcessing target from ${STEP_FUNCTION_ARN}"
    return 1
  }
}

bp_assert_state_machine_task_definition() {
  local expected_task_definition="$1"
  local expected_cluster="$2"
  local target actual_task_definition actual_cluster
  target=$(bp_state_machine_cpu_target) || return 1
  IFS=$'\t' read -r actual_task_definition actual_cluster <<<"${target}"
  if [ "${actual_task_definition}" != "${expected_task_definition}" ]; then
    bp_die "Step Functions CPUProcessing targets ${actual_task_definition}, expected ${expected_task_definition}"
    return 1
  fi
  if [ "${actual_cluster}" != "${expected_cluster}" ]; then
    bp_die "Step Functions CPUProcessing targets cluster ${actual_cluster}, expected ${expected_cluster}"
    return 1
  fi
}

bp_assert_maintenance_schedule_contract() {
  local expected_task_definition="$1" expected_cluster="$2"
  local schedule_group="$3" schedule_name="$4"
  local expected_state="${5:-}"
  local expected_role expected_dlq
  local state task_definition cluster input flexible event_age retries launch_type platform_version task_count role dlq expression
  case "${expected_state}" in
    ENABLED|DISABLED) ;;
    *)
      bp_die "maintenance schedule expected state must be explicitly ENABLED or DISABLED"
      return 1
      ;;
  esac
  expected_role="arn:aws:iam::${AWS_ACCOUNT}:role/beaver-project-asset-deletion-scheduler-role"
  expected_dlq="arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT}:beaver-project-asset-deletion-scheduler-dlq"

  state=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'State' --output text) || return 1
  task_definition=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.EcsParameters.TaskDefinitionArn' --output text) || return 1
  cluster=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.Arn' --output text) || return 1
  input=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.Input' --output text) || return 1
  flexible=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'FlexibleTimeWindow.Mode' --output text) || return 1
  event_age=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.RetryPolicy.MaximumEventAgeInSeconds' --output text) || return 1
  retries=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.RetryPolicy.MaximumRetryAttempts' --output text) || return 1
  launch_type=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.EcsParameters.LaunchType' --output text) || return 1
  platform_version=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.EcsParameters.PlatformVersion' --output text) || return 1
  task_count=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.EcsParameters.TaskCount' --output text) || return 1
  role=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.RoleArn' --output text) || return 1
  dlq=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'Target.DeadLetterConfig.Arn' --output text) || return 1
  expression=$(bp_aws scheduler get-schedule \
    --group-name "${schedule_group}" --name "${schedule_name}" \
    --region "${AWS_REGION}" --query 'ScheduleExpression' --output text) || return 1

  local -a actual=(
    "${state}" "${task_definition}" "${cluster}" "${input}" "${flexible}" "${event_age}"
    "${retries}" "${launch_type}" "${platform_version}" "${task_count}" "${role}" "${dlq}" "${expression}"
  )
  local -a expected=(
    "${expected_state}" "${expected_task_definition}" "${expected_cluster}" "None" "OFF" "600"
    "2" "FARGATE" "1.4.0" "1" "${expected_role}" "${expected_dlq}" "rate(5 minutes)"
  )
  local -a labels=(
    "state" "task definition" "cluster" "input override" "flexible window" "retry event age"
    "retry attempts" "launch type" "platform version" "task count" "role" "dead-letter queue" "expression"
  )
  local index
  for index in "${!expected[@]}"; do
    if [ "${actual[$index]}" != "${expected[$index]}" ]; then
      bp_die "maintenance schedule ${labels[$index]}: expected ${expected[$index]}, found ${actual[$index]}"
      return 1
    fi
  done
}

bp_assert_service_autoscaling_state() {
  local expected_min="${1:-}" expected_max="${2:-}" expected_suspended="${3:-}"
  local min_capacity max_capacity scale_in_suspended scale_out_suspended scheduled_scaling_suspended
  if [[ ! "${expected_min}" =~ ^[0-9]+$ ]] ||
     [[ ! "${expected_max}" =~ ^[0-9]+$ ]] ||
     [ "${expected_min}" -gt "${expected_max}" ]; then
    bp_die "expected autoscaling minimum/maximum must be explicit nonnegative integers with minimum <= maximum"
    return 1
  fi
  expected_suspended="${expected_suspended,,}"
  if [ "${expected_suspended}" != "true" ] && [ "${expected_suspended}" != "false" ]; then
    bp_die "expected autoscaling suspension must be explicitly true or false"
    return 1
  fi

  min_capacity=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].MinCapacity' \
    --output text) || return 1
  max_capacity=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].MaxCapacity' \
    --output text) || return 1
  scale_in_suspended=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].SuspendedState.DynamicScalingInSuspended' \
    --output text) || return 1
  scale_out_suspended=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].SuspendedState.DynamicScalingOutSuspended' \
    --output text) || return 1
  scheduled_scaling_suspended=$(bp_aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "service/${ECS_CLUSTER##*/}/${ECS_SERVICE##*/}" \
    --region "${AWS_REGION}" \
    --query 'ScalableTargets[0].SuspendedState.ScheduledScalingSuspended' \
    --output text) || return 1

  local -a actual=(
    "${min_capacity}" "${max_capacity}" "${scale_in_suspended,,}"
    "${scale_out_suspended,,}" "${scheduled_scaling_suspended,,}"
  )
  local -a expected=(
    "${expected_min}" "${expected_max}" "${expected_suspended}"
    "${expected_suspended}" "${expected_suspended}"
  )
  local -a labels=(
    "app autoscaling minimum" "app autoscaling maximum" "dynamic scale-in suspension"
    "dynamic scale-out suspension" "scheduled scaling suspension"
  )
  local index
  for index in "${!expected[@]}"; do
    if [ "${actual[$index]}" != "${expected[$index]}" ]; then
      bp_die "${labels[$index]}: expected ${expected[$index]}, found ${actual[$index]}"
      return 1
    fi
  done
}

bp_service_network_configuration() {
  local network
  network=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" \
    --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" \
    --query 'services[0].networkConfiguration' \
    --output json)
  if [ -z "${network}" ] || [ "${network}" = "null" ] || [ "${network}" = "None" ]; then
    bp_die "could not resolve the app service network configuration"
    return 1
  fi
  printf '%s\n' "${network}"
}

bp_wait_service_stable() {
  bp_aws ecs wait services-stable \
    --cluster "${ECS_CLUSTER}" \
    --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" || {
    bp_die "ECS service did not become stable"
    return 1
  }
}

bp_describe_task_batch_live_count() {
  local response
  local -a expected=("$@")
  response=$(bp_aws ecs describe-tasks \
    --cluster "${ECS_CLUSTER}" \
    --tasks "${expected[@]}" \
    --region "${AWS_REGION}" \
    --output json) || return 1
  printf '%s' "${response}" | node -e '
let input = "";
const expected = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const response = JSON.parse(input);
    const tasks = response?.tasks;
    const failures = response?.failures;
    if (!Array.isArray(tasks) || !Array.isArray(failures) || failures.length !== 0) process.exit(2);
    const actual = tasks.map((task) => task.taskArn);
    if (
      tasks.length !== expected.length ||
      new Set(actual).size !== actual.length ||
      expected.some((arn) => !actual.includes(arn))
    ) process.exit(2);
    process.stdout.write(String(tasks.filter((task) => task.lastStatus !== "STOPPED").length));
  } catch {
    process.exit(2);
  }
});
' "${expected[@]}" || {
    bp_die "ECS describe-tasks returned a partial/failed response for ${#expected[@]} listed tasks"
    return 1
  }
}

bp_assert_running_service_task_definition() {
  local expected_task_definition="$1"
  local expected_count="$2"
  local task_text response offset
  task_text=$(bp_aws ecs list-tasks \
    --cluster "${ECS_CLUSTER}" \
    --service-name "${ECS_SERVICE}" \
    --desired-status RUNNING \
    --region "${AWS_REGION}" \
    --query taskArns \
    --output text)
  if [ -z "${task_text}" ] || [ "${task_text}" = "None" ]; then
    if [ "${expected_count}" = "0" ]; then return 0; fi
    bp_die "ECS listed no running app tasks, expected ${expected_count}"
    return 1
  fi
  # AWS text output is a whitespace-delimited ARN list.
  # shellcheck disable=SC2206
  local tasks=( ${task_text} )
  if [ "${#tasks[@]}" -ne "${expected_count}" ]; then
    bp_die "ECS listed ${#tasks[@]} running app tasks, expected ${expected_count}"
    return 1
  fi
  for ((offset = 0; offset < ${#tasks[@]}; offset += 100)); do
    local batch=("${tasks[@]:offset:100}")
    response=$(bp_aws ecs describe-tasks \
      --cluster "${ECS_CLUSTER}" \
      --tasks "${batch[@]}" \
      --region "${AWS_REGION}" \
      --output json) || return 1
    printf '%s' "${response}" | node -e '
let input = "";
const expectedTaskDefinition = process.argv[1];
const expectedArns = process.argv.slice(2);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const response = JSON.parse(input);
    const tasks = response?.tasks;
    const failures = response?.failures;
    const actualArns = Array.isArray(tasks) ? tasks.map((task) => task.taskArn) : [];
    if (
      !Array.isArray(tasks) ||
      !Array.isArray(failures) ||
      failures.length !== 0 ||
      tasks.length !== expectedArns.length ||
      new Set(actualArns).size !== actualArns.length ||
      expectedArns.some((arn) => !actualArns.includes(arn)) ||
      tasks.some((task) => task.lastStatus !== "RUNNING") ||
      tasks.some((task) => task.taskDefinitionArn !== expectedTaskDefinition)
    ) process.exit(2);
  } catch {
    process.exit(2);
  }
});
' "${expected_task_definition}" "${batch[@]}" || {
      bp_die "running app task describe response was partial, failed, non-running, or used another revision"
      return 1
    }
  done
}

bp_assert_service_revision_stable() {
  local expected_task_definition="$1"
  local expected_count="${2:-}"
  local current_task_definition deployment_count rollout_state desired_count running_count pending_count platform_version
  if [[ ! "${expected_count}" =~ ^[0-9]+$ ]]; then
    bp_die "expected stable app service count must be an explicit nonnegative integer"
    return 1
  fi
  bp_wait_service_stable || return 1
  current_task_definition=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].taskDefinition' --output text)
  deployment_count=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'length(services[0].deployments)' --output text)
  rollout_state=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].deployments[0].rolloutState' --output text)
  desired_count=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].desiredCount' --output text)
  running_count=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].runningCount' --output text)
  pending_count=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].pendingCount' --output text)
  platform_version=$(bp_aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" --services "${ECS_SERVICE}" \
    --region "${AWS_REGION}" --query 'services[0].platformVersion' --output text)
  if [ "${current_task_definition}" != "${expected_task_definition}" ]; then
    bp_die "app service uses ${current_task_definition}, expected ${expected_task_definition}"
    return 1
  fi
  if [ "${deployment_count}" != "1" ]; then
    bp_die "app service is not on one completed deployment (found ${deployment_count})"
    return 1
  fi
  if [ "${rollout_state}" != "COMPLETED" ]; then
    bp_die "app service deployment rollout is ${rollout_state}, expected COMPLETED"
    return 1
  fi
  if [ "${platform_version}" != "1.4.0" ]; then
    bp_die "app service platform version is ${platform_version}, expected 1.4.0"
    return 1
  fi
  if [ "${desired_count}" != "${expected_count}" ] ||
     [ "${running_count}" != "${expected_count}" ] ||
     [ "${pending_count}" != "0" ]; then
    bp_die "app service counts do not match expected ${expected_count} (desired ${desired_count}, running ${running_count}, pending ${pending_count})"
    return 1
  fi
  bp_assert_running_service_task_definition "${expected_task_definition}" "${expected_count}"
}

bp_run_one_off_task() {
  local task_definition="$1"
  local overrides="${2:-}"
  local requested_client_token="${3:-}"
  local network task_arn client_token started_by response expected_cluster expected_container
  local explicit_client_token=false
  local -a args

  if [ -n "${requested_client_token}" ]; then
    if [[ ! "${requested_client_token}" =~ ^bp-[a-z0-9][a-z0-9-]{0,60}$ ]]; then
      bp_die "explicit ECS client token must be 4-64 lowercase safe characters with the bp- prefix"
      return 1
    fi
    client_token="${requested_client_token}"
    explicit_client_token=true
  else
    client_token="bp-schema-$(date -u +%s)-${BASHPID}-${RANDOM}"
  fi
  network=$(bp_service_network_configuration) || return 1
  started_by="${client_token:0:36}"
  args=(
    ecs run-task
    --cluster "${ECS_CLUSTER}"
    --task-definition "${task_definition}"
    --launch-type FARGATE
    --platform-version 1.4.0
    --network-configuration "${network}"
    --client-token "${client_token}"
    --started-by "${started_by}"
    --region "${AWS_REGION}"
  )
  if [ -n "${overrides}" ]; then
    args+=(--overrides "${overrides}")
  fi
  args+=(--output json)

  echo "[ecs-task] requesting ${task_definition} with client token ${client_token}" >&2
  if ! response=$(bp_aws "${args[@]}"); then
    bp_die "ECS RunTask outcome is unknown for client token ${client_token} (started-by ${started_by}); do not change writer state until matching family tasks and schema history are verified"
    return 1
  fi
  expected_cluster="arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT}:cluster/${ECS_CLUSTER##*/}"
  if ! task_arn=$(printf '%s' "${response}" | node -e '
let input = "";
const [
  expectedTaskDefinition,
  expectedCluster,
  expectedAccount,
  expectedRegion,
  expectedClusterName,
  explicitClientToken,
] = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const response = JSON.parse(input);
    const task = response?.tasks?.[0];
    const hasTaskDefinition = Object.hasOwn(task ?? {}, "taskDefinitionArn");
    const hasCluster = Object.hasOwn(task ?? {}, "clusterArn");
    const fullIdentity =
      task?.taskDefinitionArn === expectedTaskDefinition &&
      task?.clusterArn === expectedCluster;
    const stoppedSparseReplay =
      explicitClientToken === "true" &&
      !hasTaskDefinition &&
      !hasCluster &&
      task?.lastStatus === "STOPPED" &&
      task?.desiredStatus === "STOPPED";
    const legacyTaskArn = new RegExp(
      `^arn:aws:ecs:${expectedRegion}:${expectedAccount}:task/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`,
      "u",
    );
    const longTaskArn = new RegExp(
      `^arn:aws:ecs:${expectedRegion}:${expectedAccount}:task/${expectedClusterName}/[0-9a-f]{32}$`,
      "u",
    );
    if (
      !Array.isArray(response?.tasks) ||
      response.tasks.length !== 1 ||
      !Array.isArray(response?.failures) ||
      response.failures.length !== 0 ||
      typeof task?.taskArn !== "string" ||
      (!legacyTaskArn.test(task.taskArn) && !longTaskArn.test(task.taskArn)) ||
      (!fullIdentity && !stoppedSparseReplay)
    ) process.exit(2);
    process.stdout.write(task.taskArn);
  } catch {
    process.exit(2);
  }
});
' "${task_definition}" "${expected_cluster}" "${AWS_ACCOUNT}" "${AWS_REGION}" \
    "${ECS_CLUSTER##*/}" "${explicit_client_token}"); then
    bp_die "ECS RunTask response is partial or mismatched for client token ${client_token}; outcome is unknown, so do not change writer state"
    return 1
  fi
  echo "[ecs-task] started ${task_arn}; keep writers disabled until its terminal status is verified" >&2

  if ! bp_aws ecs wait tasks-stopped \
    --cluster "${ECS_CLUSTER}" \
    --tasks "${task_arn}" \
    --region "${AWS_REGION}"; then
    bp_die "ECS waiter failed for ${task_arn}; the task may still be running. Do not restore writers until it is explicitly STOPPED with a verified exit code"
    return 1
  fi
  if ! response=$(bp_aws ecs describe-tasks \
    --cluster "${ECS_CLUSTER}" \
    --tasks "${task_arn}" \
    --region "${AWS_REGION}" \
    --output json); then
    bp_die "could not verify terminal task ${task_arn}; do not change writer state"
    return 1
  fi
  expected_container="${task_definition##*/}"
  expected_container="${expected_container%%:*}"
  if ! printf '%s' "${response}" | node -e '
let input = "";
const [expectedArn, expectedTaskDefinition, expectedCluster, expectedContainer] = process.argv.slice(1);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const response = JSON.parse(input);
    const task = response?.tasks?.[0];
    const container = task?.containers?.[0];
    if (
      !Array.isArray(response?.tasks) ||
      response.tasks.length !== 1 ||
      !Array.isArray(response?.failures) ||
      response.failures.length !== 0 ||
      task?.taskArn !== expectedArn ||
      task?.taskDefinitionArn !== expectedTaskDefinition ||
      task?.clusterArn !== expectedCluster ||
      task?.lastStatus !== "STOPPED" ||
      !Array.isArray(task?.containers) ||
      task.containers.length !== 1 ||
      container?.name !== expectedContainer ||
      container?.lastStatus !== "STOPPED" ||
      container?.exitCode !== 0
    ) process.exit(2);
  } catch {
    process.exit(2);
  }
});
' "${task_arn}" "${task_definition}" "${expected_cluster}" "${expected_container}"; then
    bp_die "task ${task_arn} terminal response was partial, mismatched, non-stopped, or nonzero; do not change writer state"
    return 1
  fi
  printf '%s\n' "${task_arn}"
}
