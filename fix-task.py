import subprocess
import json

doc = json.dumps({
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Action": "secretsmanager:GetSecretValue",
        "Resource": "arn:aws:secretsmanager:us-east-1:100328509916:secret:beaver/GROQ_API_KEY-hCO8Nb"
    }]
})

subprocess.run([
    "aws", "iam", "put-role-policy",
    "--role-name", "beaver-ecs-execution-role",
    "--policy-name", "GroqSecretAccess",
    "--policy-document", doc
])

print("done")
