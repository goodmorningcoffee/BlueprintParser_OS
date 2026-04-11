ok back to the img2table and our entire table-parsing pipeline.  we still have not gotten
  img2table working and the cell-detector model is not working either (the one from
  └ Search img2table|camelot|TableTransformerForObjectDetection|tatr|table-structure|table
parse|
           table-parse|detectTableStructure|img2table_extract|camelot_pdfplumber_extract in src
    List src
    Search table|img2table|camelot|tatr|structure|ocr|textract|grid|parse

  assumptions against the Docker/local setup, because that’s the most likely source of the
  split failures you’re seeing.

• Ran pwd
  └ /workspaces/blueprintparser_2_april9_beforeOSrelease

• Explored
  └ List ls -la
    Search ./src in .

───────────────────────────────────────────────────────────────────────────────────────────────

• The actual repo is nested under blueprintparser_2 copy, so I’m switching into that tree now.
  I’ll stay focused on the parser path itself rather than redoing broad review.
    Search table|img2table|camelot|tatr|structure|ocr|textract|grid|parse
    Search img2table|camelot|TableTransformerForObjectDetection|tatr|table-structure|table
parse|
           table-parse|detectTableStructure|img2table_extract|camelot_pdfplumber_extract in src
    Read route.ts, img2table-extract.ts, img2table_extract.py, tatr-structure.ts,
tatr_structure.py

───────────────────────────────────────────────────────────────────────────────────────────────

• I’ve traced the wrappers and routes. Next I’m checking the native/table-specific methods and

• Explored
  └ Read table-parse.ts, grid-merger.ts, camelot-extract.ts, camelot_pdfplumber_extract.py,
         Dockerfile, check_deps.py, requirements.txt, install_setup.sh, docker-compose.yml

───────────────────────────────────────────────────────────────────────────────────────────────

• I’ve confirmed the local setup docs and the production container are not aligned. I’m
  checking the live environment now with the repo’s own dependency checker and the actual model
  directory, because that should tell us whether the TATR failure is a genuine code issue or
  just a missing runtime/model condition.

• Ran python3 scripts/check_deps.py
  └ === Python Environment ===
      [WARN]  Python version — 3.14.3 — Python 3.14+ breaks torch/torchvision
    … +32 lines
    ==================================================
    17 check(s) failed. See above for details.

• Ran python3 - <<'PY'
  │ mods=['img2table','camelot','pdfplumber','cv2','torch','transformers','timm','PIL','polars'
  │ ]
  │ … +7 lines
  └ img2table FAIL ModuleNotFoundError("No module named 'img2table'")
    camelot FAIL ModuleNotFoundError("No module named 'camelot'")
    … +5 lines
    PIL FAIL ModuleNotFoundError("No module named 'PIL'")
    polars FAIL ModuleNotFoundError("No module named 'polars'")

• Explored
  └ Search tatr in .
    Read patch_img2table.py, AutoParseTab.tsx, README.md, pdf-rasterize.ts, table-lines.ts,
         detect_table_lines.py

───────────────────────────────────────────────────────────────────────────────────────────────

• I’ve got one concrete repo-level issue already: this workspace’s actual Python environment is
  missing the entire parser stack, and the repo’s own checker fails 17 dependency checks. I’m
  doing one direct invocation of the two Python entrypoints now so I can tie the symptoms to
  what the scripts themselves return.

• Ran printf '%s' '{"image_path":"/tmp/does-not-matter.png","region_bbox":[0,0,1,1]}' | python3
  │ scripts/img2table_extract.py
  └ {"method": "img2table", "headers": [], "rows": [], "confidence": 0, "error": "img2table not
    installed"}

• Ran printf '%s' '{"image_path":"/tmp/does-not-matter.png","model_path":"models/
  │ tatr","confidence_threshold":0.5}' | python3 scripts/tatr_structure.py
  └ {"error": "Missing dependency: No module named 'torch'", "cells": [], "rows": [],
    "columns": [], "confidence": 0}

───────────────────────────────────────────────────────────────────────────────────────────────

• Findings

  1. The current local/runtime environment is not capable of running either img2table or TATR
     as-is.
     I ran the repo’s own checker, blueprintparser_2%20copy/scripts/check_deps.py, and it
     failed 17 checks in this workspace:
      - missing gs
      - missing tesseract
      - missing cv2, numpy, PIL, pdfplumber, polars
      - missing img2table, camelot
      - missing torch, torchvision, transformers, timm

     Direct script calls confirm it:
      - scripts/img2table_extract.py returns {"error":"img2table not installed"} from
        blueprintparser_2%20copy/scripts/img2table_extract.py:14
      - scripts/tatr_structure.py returns {"error":"Missing dependency: No module named
        'torch'"} from blueprintparser_2%20copy/scripts/tatr_structure.py:26

     That is the first blocker. No parser tuning matters until the runtime is real.
  2. The repo’s local setup path does not provision the table-parser stack.
     The documented local path in blueprintparser_2%20copy/README.md:525 is:
      - docker compose up -d
      - npm install
      - npm run dev

     But blueprintparser_2%20copy/docker-compose.yml:1 only starts Postgres and Label Studio,
     and blueprintparser_2%20copy/install_setup.sh does not install Python CV/ML deps. The
     parser deps only appear in the production blueprintparser_2%20copy/Dockerfile:42.

     So the codebase currently has a split-brain setup:
      - app works locally
      - parser stack is really only provisioned in the production image
  3. img2table has a hidden local-only compatibility trap even if you install it.
     The repo includes blueprintparser_2%20copy/scripts/patch_img2table.py, which exists
     specifically because img2table 0.0.12 breaks against newer Polars APIs. That patch is only
     run in the production blueprintparser_2%20copy/Dockerfile:88. It is not part of local
     setup.

     So local failure modes are:
      - img2table not installed
      - tesseract not installed
      - img2table installed but broken against modern polars
      - patch never applied

     That is a strong candidate for “it still doesn’t work locally even after pip install”.
  4. The Microsoft cell-detector path has a second deployment bug: the model is not copied into
     the runtime image.
     TATR expects model files under models/tatr, and the wrapper searches those paths in
     blueprintparser_2%20copy/src/lib/tatr-structure.ts:53. The model does exist in the repo
     locally:
      - blueprintparser_2%20copy/models/tatr/config.json
      - blueprintparser_2%20copy/models/tatr/model.safetensors
      - blueprintparser_2%20copy/models/tatr/preprocessor_config.json

     But the production blueprintparser_2%20copy/Dockerfile never copies models/ into the
     runner image. So even if the Python deps are present in Docker, TATR will fail later with
     “model not found”.

     That is separate from your current local import error, but it means the path is broken in
     two different ways depending on environment.
  5. The TATR error string you saw is consistent with a partial transformers install, not a bad
     blueprint.
     Your message:
     Could not import module 'TableTransformerForObjectDetection'. Are this object's
     requirements defined correctly?

     That string is typical of transformers lazy import behavior. It usually means one of:
      - transformers present but wrong version
      - torch / torchvision missing or incompatible
      - optional backend import chain failing

     In your code, the import happens here in blueprintparser_2%20copy/scripts/
     tatr_structure.py:30. That means the failure is runtime/package-level, not table-content-
     level.
  6. The current Python version warning is a real risk for TATR.
     blueprintparser_2%20copy/scripts/check_deps.py:33 explicitly warns that Python 3.14+
     breaks torch/torchvision. This workspace is on Python 3.14.3, and the repo itself calls
     that out. So even if you start installing dependencies locally, TATR is still at risk
     unless the Python version is brought back into a supported range.
  7. img2table failures are partially masked by the script/UI contract.
     The UI only shows error if the method result includes an error in
     blueprintparser_2%20copy/src/components/viewer/AutoParseTab.tsx:311. But the Python script
     returns empty-without-error in at least two cases:
      - df is None or df.empty in blueprintparser_2%20copy/scripts/img2table_extract.py:104
      - not rows in blueprintparser_2%20copy/scripts/img2table_extract.py:124

     So img2table can fail in a meaningful way and still surface as plain no result, which
     makes debugging much harder.
  8. Even once the environment is fixed, img2table is not especially tuned for blueprint
     schedules.
     The current path is:
      - full page rasterized at 200 DPI in blueprintparser_2%20copy/src/app/api/table-parse/
        route.ts:78
      - crop performed in blueprintparser_2%20copy/scripts/img2table_extract.py:48
      - raw cropped image passed into Img2TableImage
      - OCR via TesseractOCR(lang="eng") in blueprintparser_2%20copy/scripts/
        img2table_extract.py:75
      - no preprocessing
      - no adaptive strategy by schedule type
      - no user-exposed img2table tuning in the options panel

     The wrapper hardcodes:
      - dpi: 200
      - detect_rotation: false
      - min_confidence: 30
        in blueprintparser_2%20copy/src/lib/img2table-extract.ts:35

     That may be fine for many docs, but blueprint schedules often need:
      - higher raster resolution
      - thresholding/contrast cleanup
      - different OCR confidence thresholds
      - line enhancement
  9. The TATR implementation is more “row/column detector” than true final cell detector.
     In blueprintparser_2%20copy/scripts/tatr_structure.py:106, cells are synthesized by
     intersecting detected row boxes with detected column boxes. That means:
      - if row detection is wrong, cells are wrong
      - if column detection is wrong, cells are wrong
      - merged/spanning cell handling is heuristic, not authoritative

     So even after you fix the import/runtime issue, this path may still underperform on
     irregular blueprint schedules. That is not the current blocker, but it is a likely second-
     order quality problem.

  For img2table:

  1. Local runtime/bootstrap is incomplete.
  2. Local img2table installs can still break because the Polars patch only runs in Docker.
  3. Empty outputs are silently downgraded to no result.
  4. After that, blueprint-specific tuning/preprocessing is still weak.

  What I would conclude
  This is not one bug. It is a stack of issues:

  - environment provisioning problem
  - local-vs-Docker inconsistency
  - one deployment packaging bug for TATR models
  If you want, next I can turn this into a strict action plan in order:

  1. what to verify first,
  2. what would make img2table actually executable,
  3. what would make TATR actually executable,
  4. then what quality experiments to run once both paths are alive.

• That changes the diagnosis materially. I’m checking the AWS/container path now: image build,
  runtime packaging, and anything that would make these features fail specifically in the
  deployed runner rather than local dev.

• Explored
  └ Read ecs.tf, entrypoint.sh, package.json
    Search Dockerfile|docker build|ECR|ecs task|container_definitions|image_uri|nextjs|
entrypoint|
           models/tatr|scripts/check_deps|patch_img2table|python3 ./scripts/patch_img2table.py|
           process-worker|SageMaker|bp2-tatr|img2table in infrastructure

───────────────────────────────────────────────────────────────────────────────────────────────

• I have enough to revise the diagnosis. One more check on the deploy path will tell us whether
  AWS is likely running an image that never picked up the parser/runtime changes, or whether
  the image itself is missing required assets.

• Explored
  └ Read deploy.sh, .deploy.env.example
    Search COPY --from=builder /app/models|models/tatr|check_deps.py|python3 scripts/
check_deps.py|
           docker build .*Dockerfile|beaver_app.repository_url|:latest in deploy.sh

───────────────────────────────────────────────────────────────────────────────────────────────

• I found one AWS-specific issue for sure already: the TATR model files are never copied into
  the ECS app image, so that path cannot work in the deployed container even if imports
  succeed. I’m checking whether the image-based table methods have a second AWS-specific
  failure around PDF access or rasterization.

• Explored
  └ Read s3.ts, route.ts
    Search getS3Url\(|downloadFromS3\(|original.pdf|dataUrl in src

───────────────────────────────────────────────────────────────────────────────────────────────

• Yes, that changes the picture.

  If this is failing on AWS, then the main problem is not your local environment. It’s the
  deployed container/runtime path. After re-reading the code with that assumption, I think
  there are two strong AWS-side issues and one likely third one.

  Most likely AWS breakages

  1. TATR is definitely broken in the deployed app image

     The TATR wrapper expects a Hugging Face model directory at models/tatr in
     blueprintparser_2%20copy/src/lib/tatr-structure.ts:53 and blueprintparser_2%20copy/
     scripts/tatr_structure.py:197.

     The model files do exist in the repo:
      - blueprintparser_2%20copy/models/tatr/config.json
      - blueprintparser_2%20copy/models/tatr/model.safetensors
      - blueprintparser_2%20copy/models/tatr/preprocessor_config.json

     But the production blueprintparser_2%20copy/Dockerfile never copies models/ into the
     runner image. It copies:
      - public
      - .next/standalone
      - .next/static
      - drizzle
      - entrypoint.sh
      - scripts
      - src/data
      - dist/process-worker.js

     It does not copy models/tatr.

     So on AWS, even if imports succeed, TATR should fail with “model not found”. That path is
     structurally broken in the image.
  2. img2table depends on Python/native runtime that only exists if the AWS image was built
     from the current Dockerfile

     The Python stack for table parsing is installed only in the production
     blueprintparser_2%20copy/Dockerfile:42:
      - ghostscript
      - python3
      - tesseract-ocr
      - opencv-python-headless
      - pdfplumber
      - camelot-py[base]
      - img2table
      - torch
      - transformers
      - timm

     So for AWS, either:
      - your deployed ECR image predates those additions, or
      - the current image still has runtime incompatibilities

     The repo’s deploy path in blueprintparser_2%20copy/deploy.sh does build and push :latest,
     so this is not a codepath omission. But if AWS “nothing works,” the first thing I’d
     suspect operationally is:
      - the running ECS tasks are on an older image, or
      - the image built successfully but the parser runtime inside it is still broken
  3. img2table has a likely packaging/compatibility risk even in AWS

     The repo includes blueprintparser_2%20copy/scripts/patch_img2table.py specifically because
     img2table 0.0.12 breaks with newer Polars APIs. That patch is run in the Docker image,
     which is good.

     But the packaging is still brittle:
      - blueprintparser_2%20copy/scripts/requirements.txt:15 explicitly lists polars>=1.0
      - the blueprintparser_2%20copy/Dockerfile does not explicitly install polars
      - the repo relies on img2table’s dependency graph plus a post-install patch

     That may still work, but it is fragile enough that I would treat it as suspicious until
     confirmed from ECS logs.

  Important difference between the two failing features

  - TATR is very likely broken because the model files are missing from the deployed image
  - img2table is more likely broken because of runtime/package issues or a stale deployment,
    not because of missing repo code

  One architectural inconsistency worth noting
  The two endpoints fetch PDFs differently:

  - /api/table-parse fetches PDF via URL using blueprintparser_2%20copy/src/lib/s3.ts:43 in
    blueprintparser_2%20copy/src/app/api/table-parse/route.ts:73
  - /api/table-structure downloads directly from S3 using AWS SDK in blueprintparser_2%20copy/
    src/app/api/table-structure/route.ts:59

  That means:

  - TATR can fail even when table-parse can still fetch the PDF
  - and vice versa if CloudFront/S3 URL access is flaky

  I don’t think that’s the primary issue here, but it is an unnecessary split and a real AWS
  failure surface.

  What I think is happening on AWS

  My best ranking now is:

  1. TATR is broken because models/tatr is not in the ECS image
      - is hitting a runtime dependency issue inside the container
  3. After that, even once alive, img2table may still underperform on blueprint schedules
     because it’s not heavily tuned

  What to verify first in AWS
  If I were debugging this live, in order:

  1. Check CloudWatch logs for the app task around:
      - [img2table]
      - [TATR]
      - [table-parse]
      - [table-structure]
  2. In a running ECS task, verify:
      - python3
      - gs
      - tesseract
      - python3 -c "import img2table, camelot, cv2, torch, transformers, timm"
      - existence of /app/models/tatr
  3. Confirm the deployed container image was built after the Dockerfile parser changes.

  Bottom line
  For AWS specifically:

  - TATR is almost certainly broken by image packaging
  - img2table is most likely broken by deployed runtime/image state
  - This is not just “the model doesn’t like your blueprint”

  If you want, I can now give you a very concrete AWS debugging checklist:

  - exact ECS commands
  - exact CloudWatch log queries
  - exact things to verify inside the running container
  - and what each possible result would mean.


› yes what ECS debug commands that i run locally right i have AWS CLI setup


• Run these from your local machine. They’re ordered so you can narrow this down fast.

  Replace values only if your deployed names differ from Terraform.

  export AWS_REGION=us-east-1
  export ECS_CLUSTER=blueprintparser-cluster
  export ECS_SERVICE=blueprintparser-app
  export LOG_GROUP=/ecs/blueprintparser-app

  1. Confirm what ECS is actually running

  aws ecs describe-services \
    --region "$AWS_REGION" \
    --cluster "$ECS_CLUSTER" \
    --services "$ECS_SERVICE" \
    --query 'services[0].
  {taskDef:taskDefinition,running:runningCount,pending:pendingCount,events:events[0:5]}'

  Get the current task definition revision:

  aws ecs describe-services \
    --region "$AWS_REGION" \
    --cluster "$ECS_CLUSTER" \
    --services "$ECS_SERVICE" \
    --query 'services[0].taskDefinition' \
    --output text

  Inspect the image URI that revision uses:

  TASKDEF=$(aws ecs describe-services \
    --region "$AWS_REGION" \
    --cluster "$ECS_CLUSTER" \
    --services "$ECS_SERVICE" \
    --query 'services[0].taskDefinition' \
    --output text)

  aws ecs describe-task-definition \
    --region "$AWS_REGION" \
    --task-definition "$TASKDEF" \
    --query 'taskDefinition.containerDefinitions[0].image'

  2. See recent app logs
  This is the first high-signal check.

  aws logs tail "$LOG_GROUP" \
    --region "$AWS_REGION" \
    --since 2h \
    --follow

  In another terminal, filter for the relevant parser paths:

  aws logs tail "$LOG_GROUP" \
    --region "$AWS_REGION" \
    --since 2h \
    | rg "img2table|TATR|table-parse|table-structure|camelot|pdfplumber|Ghostscript|tesseract|
  model not found|Missing dependency"

  3. Find the current running task

  aws ecs list-tasks \
    --region "$AWS_REGION" \
    --cluster "$ECS_CLUSTER" \
    --service-name "$ECS_SERVICE"

  Get one task ARN:

  TASK_ARN=$(aws ecs list-tasks \
    --region "$AWS_REGION" \
    --cluster "$ECS_CLUSTER" \
    --service-name "$ECS_SERVICE" \
    --query 'taskArns[0]' \
    --output text)

  echo "$TASK_ARN"

  4. Exec into the running app container
  This is the most important step if ECS Exec is enabled.

  aws ecs execute-command \
    --region "$AWS_REGION" \
    --cluster "$ECS_CLUSTER" \
    --task "$TASK_ARN" \
    --container blueprintparser-app \
    --interactive \
    --command "/bin/sh"

  If that fails, check whether ECS Exec is enabled:

  aws ecs describe-tasks \
    --region "$AWS_REGION" \
    --cluster "$ECS_CLUSTER" \
    --tasks "$TASK_ARN" \
    --query 'tasks[0].enableExecuteCommand'

  5. Inside the container, verify the parser runtime
  Run these inside the shell from step 4.

  Basic binaries:

  which python3
  which gs
  which tesseract
  python3 --version

  Python imports:

  python3 - <<'PY'
  mods=['img2table','camelot','pdfplumber','cv2','torch','transformers','timm','PIL','polars']
  for m in mods:
      try:
          mod=__import__(m)
          print(m, 'OK', getattr(mod,'__version__', ''))
      except Exception as e:
          print(m, 'FAIL', repr(e))
  PY

  Run the repo’s dependency checker:

  python3 scripts/check_deps.py

  Check the TATR model files:

  ls -la /app/models
  ls -la /app/models/tatr
  find /app/models/tatr -maxdepth 1 -type f

  If /app/models/tatr is missing, that is your TATR breakage.

  6. Directly reproduce the two failing Python entrypoints inside ECS
  Still inside the container:

  img2table smoke test:

  printf '%s' '{"image_path":"/tmp/does-not-matter.png","region_bbox":[0,0,1,1]}' | python3
  scripts/img2table_extract.py

  TATR smoke test:

  printf '%s' '{"image_path":"/tmp/does-not-matter.png","model_path":"/app/models/
  tatr","confidence_threshold":0.5}' | python3 scripts/tatr_structure.py

  What the outputs mean:

  - img2table not installed -> image/runtime problem
  - Missing dependency: ... -> Python package chain problem
  - Model not found at /app/models/tatr -> Docker image packaging bug
  - import error around TableTransformerForObjectDetection -> transformers/torch/timm mismatch

  7. Confirm the Docker image actually contains the expected files
  Still inside ECS:

  ls -la /app/scripts | rg 'img2table|camelot|tatr|check_deps|patch'

  Check whether the patch script exists:

  ls -la /app/scripts/patch_img2table.py

  If img2table imports but fails later, the patch may not have been applied correctly.

  8. Inspect the currently deployed image digest
  Back on your local machine:

  From the task definition image URI:

  aws ecs describe-task-definition \
    --region "$AWS_REGION" \
    --task-definition "$TASKDEF" \
    --query 'taskDefinition.containerDefinitions[0].image' \
    --output text

  Then compare it against ECR:

  aws ecr describe-images \
    --region "$AWS_REGION" \
    --repository-name blueprintparser-app \

  If ECS is running an older digest than you expect, you may simply be debugging stale code.

  9. Trigger a fresh deployment if needed

  aws ecs update-service \
    --service "$ECS_SERVICE" \
    --force-new-deployment

  Then watch it:

  aws ecs describe-services \
    --services "$ECS_SERVICE" \
    --query 'services[0].deployments'
  Most likely:


  Fastest path
  1. aws logs tail ... | rg "img2table|TATR|table-parse|table-structure"
  2. ECS Exec into the container and run python3 scripts/check_deps.py
  3. ls -la /app/models/tatr

  If you want, after you run those, paste the outputs here and I’ll interpret them.


› can you do an extra deep dive into img2table.  we need to really trace out what is holding us back from implementing it.
  what does their github say, are there communitites online who have similar problems installing or advcie for getting it
  to run? the same with tatr


• I’m doing a deeper pass on both the repo integration and the upstream projects now: local wrapper assumptions, the Docker/
  runtime chain, and then img2table/TATR upstream docs and issue patterns. I’ll separate “proven from your code” from
  “likely from upstream/community reports” so the diagnosis is defensible.

• Searching the web

• Searched img2table GitHub installation issues polars tesseract ghostscript blueprint table extraction issues

• Searching the web

• Searched https://github.com/xavctn/img2table

• Searching the web

• Searched site:github.com/xavctn/img2table issue polars img2table 0.0.12

• Searching the web

• Searched 'pdf_text_extraction' in https://github.com/xavctn/img2table

• Searching the web

• Searched https://github.com/xavctn/img2table/issues

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

• Deep Dive

  The biggest new finding is this: your img2table integration is fighting the library instead of using it the way it wants
  to be used, and your TATR integration is built on a less-stable path than the official Microsoft repo.

  What’s holding back img2table

  1. You are using img2table in image mode, not PDF mode

     In your code, /api/table-parse rasterizes the whole page to PNG, then passes the page image into img2table:
      - blueprintparser_2%20copy/src/app/api/table-parse/route.ts:78
      - blueprintparser_2%20copy/src/lib/img2table-extract.ts:35
      - blueprintparser_2%20copy/scripts/img2table_extract.py:71

     Upstream, img2table has a distinct PDF path and explicitly says:
      - PDF mode supports pdf_text_extraction=True
      - native PDFs can use embedded text directly instead of OCR
      - PDF pages are converted internally at 200 DPI for table identification
        Source: blueprintparser_2%20copy/README.md is repo-local for BP, but upstream docs here:
      - https://github.com/xavctn/img2table
      - relevant excerpt: turn3view0 (https://github.com/xavctn/img2table), turn3view1 (https://github.com/xavctn/img2table)

     That means your current integration throws away one of img2table’s main strengths on native PDFs:
      - direct PDF text extraction
      - page-level PDF context
      - library-owned PDF rasterization path

     For blueprint schedules inside real PDFs, that is a meaningful handicap.
  2. Your current img2table path is fully dependent on Tesseract quality

     Your script always does:
      - crop raster image
      - Img2TableImage(...)
      - TesseractOCR(lang="eng")
      - extract_tables(...)

     See blueprintparser_2%20copy/scripts/img2table_extract.py:71.

     Upstream explicitly says:
      - results are “highly dependent on OCR quality”
      - “tables where no OCR data can be found are not returned”
      - library is tailored to “white/light background” docs
      - if it fails, you may need CNN-based solutions
        Source:
      - https://github.com/xavctn/img2table
      - relevant excerpt: turn3view2 (https://github.com/xavctn/img2table)

     That matches your reality. Blueprint schedules are often:
      - low-contrast
      - tiny text
      - thin lines
      - non-document-like compared to invoices/forms

     So if Tesseract is weak on those crops, img2table will simply return nothing.
  3. You are not using some of the knobs upstream expects people to tune

     Your wrapper hardcodes:
      - dpi: 200
      - detect_rotation: false
      - min_confidence: 30

     See blueprintparser_2%20copy/src/lib/img2table-extract.ts:35.

     Your Python script defaults:
      - implicit_rows=True
      - no borderless_tables
      - no implicit_columns
      - plain Tesseract defaults

     See blueprintparser_2%20copy/scripts/img2table_extract.py:24.

     Upstream docs expose more tuning than you currently use, including:
      - psm for Tesseract
      - tessdata_dir
      - borderless_tables
      - implicit row/column controls
        Source: turn3view0 (https://github.com/xavctn/img2table), turn3view2 (https://github.com/xavctn/img2table)

     For blueprint schedules, borderless_tables and OCR settings matter a lot.
  4. Your install path is brittle because img2table needed a custom patch

     You already know this, and the repo proves it:
      - blueprintparser_2%20copy/scripts/patch_img2table.py exists specifically to fix Polars incompatibilities
      - it only runs in blueprintparser_2%20copy/Dockerfile:88

     That tells me upstream/library compatibility has already bitten this project once. This is not a mature “set and
     forget” dependency in your stack.
  5. Community issue patterns suggest install/runtime friction is normal

     The current open issues for img2table include:
      - more detailed instructions
      - Tesseract path handling
      - inconsistent table detection across pages
      - border-related extraction issues
        Source: https://github.com/xavctn/img2table/issues and turn4view0 (https://github.com/xavctn/img2table/issues)

     That doesn’t prove your exact bug, but it does tell you this library has:
      - real installation friction
      - detection inconsistency on real documents
      - sensitivity to environment and document style

  What’s holding back TATR

  1. Your deployed image is missing the model files

     This is the clearest deterministic bug.

     Your TATR wrapper looks for:
      - /app/models/tatr
      - or ../models/tatr

     in blueprintparser_2%20copy/src/lib/tatr-structure.ts:53.

     But your production blueprintparser_2%20copy/Dockerfile never copies models/ into the runner image.

     So on AWS, that path cannot work reliably even if imports succeed.
  2. Your TATR path is not using the official Microsoft inference stack

     The official Microsoft repo is its own codebase and environment:
      - https://github.com/microsoft/table-transformer
      - it documents its own inference pipeline and environment
      - it explicitly notes Python 3.10.9, PyTorch 1.13.1, Torchvision 0.14.1 in its environment update
        Source: turn3view3 (https://github.com/microsoft/table-transformer)

     Your implementation instead uses:
      - from transformers import TableTransformerForObjectDetection, AutoImageProcessor
      - local HF-format weights
      - a custom wrapper
        See blueprintparser_2%20copy/scripts/tatr_structure.py:30.

     That is a valid approach in principle, but it’s not the official path from Microsoft.
  3. The Hugging Face/Transformers route is historically a port, not the original implementation

     The HF integration came via the Transformers ecosystem rather than the original Microsoft repo. There is a GitHub issue
     discussing adding Table Transformer models to Hugging Face Transformers:
      - https://github.com/microsoft/table-transformer/issues/68

     That matters because your code is depending on the HF port path, not on the official repo’s own inference
     implementation.
  4. The import error you saw is a known kind of ecosystem mismatch

     Your error:
      - Could not import module 'TableTransformerForObjectDetection'...

     is exactly the class of issue people hit when:
      - transformers version is wrong
      - torch / torchvision backend is missing or incompatible
      - model backend imports fail lazily

     There is at least one public Hugging Face discussion around import/runtime trouble for
     TableTransformerForObjectDetection:
      - https://huggingface.co/microsoft/table-transformer-detection/discussions/10

     I would not overfit to that exact thread, but it confirms this is not a weird BP-only symptom.
  5. Your package versions are not aligned with upstream’s documented environment

     Upstream Microsoft notes:
      - Python 3.10.9
      - PyTorch 1.13.1
      - Torchvision 0.14.1
        Source: turn3view3 (https://github.com/microsoft/table-transformer)

     Your Dockerfile installs:
      - torch==2.5.1+cpu
      - torchvision==0.20.1+cpu
      - transformers>=4.40.0,<5.0.0
      - timm>=0.9.0,<2.0.0
        See blueprintparser_2%20copy/Dockerfile:67.

     That may work, but it is not an upstream-matched environment. So if you’re getting import/runtime weirdness, this
     version skew is a serious suspect.

  One important product-level insight

  img2table and TATR are not the same kind of tool:

  - img2table is a practical CV/OCR table extractor that works best when document/OCR assumptions are friendly
  - TATR is a learned structure detector trained mostly on PubTables-style document tables, not construction-specific
    schedules

  Microsoft’s own repo says the pre-trained weights are for PubTables-1M-derived domains unless you train your own model
  variants:

  - turn3view4 (https://github.com/microsoft/table-transformer)
  - turn3view5 (https://github.com/microsoft/table-transformer)

  So even after you fix runtime issues, TATR may still be a weak fit for blueprint schedules unless the domain transfer is
  good enough.

  My current diagnosis

  If the goal is “what is holding us back from implementing these successfully,” I would rank it like this:

  1. TATR

  - guaranteed deployment bug: model files not in ECS image
  - likely runtime fragility: HF/Transformers import path
  - likely version skew vs official environment
  - possible domain mismatch after it runs

  2. img2table

  - integration shape mismatch: using Image on a raster crop instead of PDF on native PDFs
  - OCR dependency is too strong for blueprint schedules
  - not enough exposed tuning
  - known install/runtime friction upstream
  - still may need preprocessing or alternate OCR backend

  What I would do conceptually

  For img2table:

  - Treat native PDF parsing as the primary path, not raster-image mode, when the source is a real PDF.
  - Preserve library-native PDF text extraction when possible.
  - Expose OCR/structure knobs:
      - psm
      - min_confidence
      - borderless_tables
      - implicit_rows
      - maybe alternate OCR backend
  - Accept that blueprint schedules are a hard case and benchmark by schedule type.

  For TATR:

  - First make the deployed path actually complete:
      - model files in image
      - known-good runtime
  - Strongly consider aligning closer to the official Microsoft environment before debugging higher-level behavior.
  - Assume the stock model may not generalize well enough to blueprint schedules.

  Bottom line

  img2table looks blocked mostly by integration strategy + OCR sensitivity.
  TATR looks blocked mostly by deployment/runtime packaging.

  And for both of them, there is a deeper truth: these upstream tools were not designed specifically for construction
  blueprints, so “working” and “working well on your documents” are two different milestones.

  Sources:

  - img2table GitHub: https://github.com/xavctn/img2table
  - img2table issues: https://github.com/xavctn/img2table/issues
  - Microsoft Table Transformer repo: https://github.com/microsoft/table-transformer
  - HF integration discussion: https://github.com/microsoft/table-transformer/issues/68
  - HF runtime discussion: https://huggingface.co/microsoft/table-transformer-detection/discussions/10

  If you want, I can next turn this into a decision memo:

  1. whether img2table is worth rescuing,
  2. whether TATR is worth rescuing,
  3. or whether you should pivot to a different table-structure strategy for blueprint schedules.


  --------below is img2table plan discussion 


   This is a much better plan than the current implementation, especially on img2table.

  The strongest part is the core architectural correction:

  - PDF mode should be primary
  - image mode should be fallback
  - both routes should fetch the original PDF the same way
  - failures need to stop being silent

  That is the right direction.

  What I agree with most

  1. Using native PDF mode for img2table

     This is the biggest win in the whole plan.

     You already preserve original.pdf in S3, and your current integration throws away that advantage by converting
     everything to a page PNG first. For native vector schedules, img2table PDF mode is exactly the thing most worth trying.
  2. Fixing silent failure before chasing quality

     Also right.

     Until the system distinguishes:
      - skipped
      - infra failed
      - parser crashed
      - parser returned empty
      - parser returned bad structure

     you are mostly debugging blind.
  3. Treating wrapped text and variable columns as first-class problems

     This is also right, and it matches what you actually care about more than “can the library import.”
  4. Including TATR but not overbetting on it

     Also right.
     TATR is worth getting alive, but it should not be the main strategic bet for blueprint schedules.

  ———

  What I would tighten or change

  1. I would not start by building a new /api/parser-health endpoint

     It’s useful, but it’s not the first thing I’d do.

     Why:
      - it adds a new production-facing surface
      - it can become stale quickly
      - it’s not the shortest path to clarity if you already have AWS CLI + ECS exec + CloudWatch

     For internal debugging, ECS exec + log instrumentation is enough.
     I’d treat /api/parser-health as optional, not Phase 1 critical path.
  2. I would not make img2table the “primary method” in the merger too early

     I agree with making PDF mode the primary img2table path, but not with emotionally treating img2table as the new
     canonical parser until you see results.

     Better framing:
      - make img2table PDF a first-class method
      - compare it against Textract/OpenCV on real schedules
      - then decide whether it should dominate or complement

     You still haven’t seen what it does on your docs, so the plan should preserve that uncertainty.
  3. The plan is slightly too optimistic about img2table PDF mode filtering

     The region-filtering part is non-trivial.

     It assumes:
      - the library exposes reliable table bounding boxes in a usable coordinate space
      - those coordinates line up cleanly with your normalized region bbox
      - page indexing and crop alignment are stable

     That’s all solvable, but I would explicitly mark this as a likely integration wrinkle, not just a routine detail.
  4. Phase 3 version strategy for TATR is reasonable, but I would be even more conservative

     I strongly agree with:
      - fix image packaging first
      - test the current stack before downgrading versions

     But I would go one step further:
      - do not touch Torch/Transformers versions at all until the model files are definitely present and the import still
        fails inside ECS

     That sequencing matters because TATR currently has an obvious hard failure already: missing model assets.

  ———

  What I think the real execution order should be

  If this were my project, I’d do it in this order:

  1. Stop silent failure

  - route logs
  - method-level explicit errors
  - UI should not show green success for empty parse

  2. Fix AWS/container truth for TATR

  - model files in image
  - confirm imports in ECS
  - only then evaluate version mismatch

  3. Unify PDF retrieval

  - both table-parse and table-structure should use the same S3 download path

  4. Implement img2table PDF mode

  - but keep the old image mode available during transition
  - compare outputs rather than assuming victory

  5. Only then add tuning UI

  - once you actually know which knobs matter

  That is the shortest route to useful signal.

  ———

  What I think is smartest in the plan

  The smartest idea in the whole thing is this:

  - for native PDFs, use the native PDF as long as possible
  - only rasterize when a method actually requires raster input

  That should become a general principle for this pipeline, not just for img2table.

  Right now the system too often collapses everything into a raster-first worldview.
  That loses structure.

  ———

  What I’d watch out for

  1. Builder image size / deployment churn

     Copying models/tatr into the app image is correct, but it will slow builds and bloat the app container. Probably
     acceptable for now, but worth acknowledging.
  2. Timeouts

     If img2table PDF mode is fast, good.

     The hardest part will not be getting img2table to return rows.
     It will be getting rows that are:
      - not over-split by wrapped text
      - not over-split into fake columns
      - stable enough to be useful

  That’s where your actual benchmark needs to live.

  ———

  My verdict

  Yes, this is a solid plan.

  The strongest parts are:

  - PDF mode first
  - explicit failure surfacing
  - TATR packaging fix
  - not blindly downgrading ML stack versions

  The parts I’d soften are:

  - new health endpoint as a must-have
  - assuming img2table becomes the primary parser before seeing output
  - underestimating the complexity of PDF-mode region filtering

  If you want the blunt version:

  - This plan is good enough to follow
  - but the real success criterion is not “library runs”
  - it’s “wrapped rows and wide description columns parse better than today”

  If you want, I can now rewrite this into a tighter engineering brief:

  - cut the fluff
  - reduce it to the minimum implementation sequence
  - call out the exact hypotheses each phase is meant to prove.


› how would you solve for wrapped rows and wide description collumns ? give some concrete strengthening of this plan


• Wrapped rows and wide description columns are the core problem. If you don’t design for them explicitly, img2table,
  OpenCV, and TATR will all look worse than they really are.

  I would strengthen the plan by making this a structure-normalization problem, not just a “pick a better parser” problem.

  What is actually going wrong

  Two common failures:

  1. Wrapped text becomes fake extra rows

  - a long description wraps onto 2-3 visual lines
  - parser sees those baselines as separate rows
  - tag/qty columns stay blank on the wrapped continuation lines
  - output becomes fragmented

  2. A wide description column gets split into multiple columns

  - inner text alignment creates repeated left edges
  - OCR-based column clustering mistakes those as separate columns
  - borderless or lightly ruled tables amplify this
  - variable-width columns break any simple “uniform gap” heuristic

  So I would add a dedicated post-parse normalization stage after each method, and possibly a pre-merge repair stage.

  ## Concrete strengthening of the plan

  ### 1. Add a “row continuation merge” stage

  This should run on method outputs before final merge.

  For each adjacent pair of rows, compute a continuation score. Merge them if the score is high.

  Signals that row B is a continuation of row A:

  - leftmost ID/tag/number column is blank in row B but filled in row A
  - qty/size/type columns are blank in row B but filled in row A
  - only the description/comments/spec column has text in row B
  - row B starts lower but with similar horizontal span as the description cell above
  - there is no strong horizontal ruling line between them
  - the vertical gap between A and B is small relative to normal row gaps on the table
  - row B text is indented relative to A inside the same wide column
  - Tesseract word boxes in row B sit fully inside the inferred description column band, not across the whole table

  What to do on merge:

  - concatenate the description cell text with newline or space
  - preserve row A’s key columns
  - delete row B
  - keep a provenance flag like mergedFromWrappedLines: true

  This directly fixes:

  - wrapped sentences parsed as multiple rows
  - hierarchical schedule entries where the continuation line only belongs to one wide cell

  ### 2. Classify columns by role before trusting structure

  Before deciding row merges or column splits, infer likely column roles.

  Heuristics:

  - narrow columns with short tokens and high fill consistency are likely tag, qty, mark, size
  - one very wide column with long average text length is likely description / remarks
  - columns with many long multi-word values should resist splitting
  - columns with mostly numeric or short codes should resist row wrapping logic

  Why this matters:

  - wide text columns should be treated differently from narrow structured columns
  - if the parser knows “this is probably the description column,” it can merge wrapped continuations much more confidently

  In your current stack, this could sit logically near:

  - blueprintparser_2%20copy/src/lib/services/table-parse.ts:35
  - blueprintparser_2%20copy/src/lib/grid-merger.ts

  ### 3. Add “anti-split” logic for wide columns

  Right now OCR column detection is vulnerable to fake internal edges inside long text.

  I would add a repair step that says:

  - if two adjacent columns are both sparse
  - and one or both are mostly text fragments
  - and rows frequently contain content in only one of them at a time
  - and their combined span behaves like one semantic column
    then merge them into one column candidate

  Strong merge signals:

  - same rows alternate between left sub-column and right sub-column rather than using both
  - combined text length distribution looks like a normal description field
  - header row above spans both, or only one header exists over the pair
  - no strong vertical ruling line exists between them in OpenCV / pdfplumber / Camelot evidence
  - Textract table result has fewer columns than OCR/image methods in that area

  This is exactly the kind of repair needed for:

  - very wide remarks/spec columns
  - variable-width layouts
  - text-induced fake column boundaries

  ### 4. Introduce cross-method “column consensus with asymmetry”

  Do not treat every method equally when deciding wide columns.

  For example:

  - if OCR method says 7 columns
  - OpenCV says 5
  - Textract says 5
  - img2table PDF says 5
    then the 7-column OCR result is probably over-splitting a wide text column

  So instead of simple shape compatibility, add a repair rule:

  - if one method has materially more columns than the others
  - and the extra columns are low-density text fragments
  - try collapsing adjacent columns until it aligns with the consensus

  That would be a major strengthening of blueprintparser_2%20copy/src/lib/grid-merger.ts, which currently mostly protects
  against wildly incompatible grids but does not actively repair likely over-segmentation.

  ### 5. Make row detection use “blank structured columns” as evidence

  This is the most reliable signal for wrapped rows in schedules.

  Typical wrapped-row pattern:

  - Row A:
      - Tag = D101
      - Qty = 2
      - Desc = HOLLOW METAL DOOR WITH VISION
  - Row B:
      - Tag = ``
      - Qty = ``
      - Desc = PANEL AND 45 MIN FIRE RATING

  That should almost never become two logical rows.

  So the normalization step should explicitly detect:

  - structured columns blank below
  - description column continues
  - merge

  This is stronger than pure geometry alone.

  ### 6. Add “section row” and “spanning row” detection

  Nested hierarchies are often not really regular rows.

  Examples:

  - “ALUMINUM WINDOWS”
  - then several child rows under it
  - or a full-width category heading above detail lines

  Those should not force a rectangular interpretation.

  I would add row types:

  - data
  - continuation
  - section
  - spanning

  Signals for section:

  - text appears in one very wide span
  - neighboring narrow columns are empty
  - font/positioning is different if detectable
  - no numeric/tag pattern present

  Signals for continuation:

  - follows a normal data row
  - only wide text column is populated
  - structured columns blank

  This would help prevent the parser from flattening hierarchy into nonsense.

  ### 7. Use OCR word boxes inside the cell, not just cell text

  For wrapped rows and wide columns, the text content alone is not enough.

  You want to retain intermediate geometry:

  - word bounding boxes
  - line groupings inside a cell
  - column band occupancy

  Why:

  - continuation lines often sit within the same x-band as the previous description
  - fake split columns often have text that still occupies one broad visual block

  So I would strengthen the plan by keeping richer per-method geometry longer before collapsing to plain strings.

  ### 8. Benchmark on schedule archetypes, not just “works / doesn’t”

  You need explicit test buckets:

  1. strongly ruled schedule
  2. lightly ruled schedule
  3. borderless schedule
  4. schedule with wrapped description text
  5. schedule with one extremely wide description column
  6. hierarchical schedule with section headings
  7. schedule with merged header cells

  Then score methods and normalization separately:

  - raw parser output
  - after row-wrap normalization
  - after anti-split column normalization

  Otherwise you won’t know whether the improvement came from img2table, PDF mode, or your repair logic.

  ## How I’d modify the plan structure

  I would add a new phase between “rescue img2table” and “fix TATR”:

  Phase 2.5: Structural Normalization
  Goal: make parser outputs usable on blueprint schedules with wrapped text and variable-width columns.

  Work items:

  - row continuation merge
  - description-column inference
  - adjacent-column anti-split repair
  - section/spanning row detection
  - cross-method consensus-based repair
  - richer disagreement diagnostics for over-segmented methods

  That phase is at least as important as getting img2table alive.

  ## If I had to be very concrete

  The most valuable immediate rules would be:

  1. Continuation row merge rule
     Merge row i+1 into row i when:

  - first key column blank in i+1
  - at least 2 narrow structured columns blank in i+1
  - wide text column non-empty in both
  - vertical gap small
  - no strong separator line between them

  2. Wide-column anti-split rule
     Merge adjacent columns j and j+1 when:

  - both are text-heavy
  - combined width is plausible as one description column
  - one or both are sparse
  - across rows, text alternates between them rather than using both independently
  - other methods support fewer columns there

  3. Section row rule
     Mark a row as section/spanning when:

  - only one broad text span contains content
  - narrow structured columns are empty
  - row does not match tag/qty/data pattern

  These three alone would materially improve your failure modes.

  ## Bottom line

  If you want this pipeline to work on real blueprint schedules, the answer is not just:

  - make img2table run
  - make TATR run

  The answer is:

  - make them run
  - then normalize for wrapped text, spanning rows, and variable-width columns

  That normalization layer is probably the real product advantage, because upstream tools won’t solve blueprint hierarchy
  cleanly on their own.

  If you want, I can next turn this into a very concrete algorithm spec:

  - exact inputs/outputs
  - scoring rules for row continuation
  - scoring rules for anti-split columns
  - where it should sit in your current pipeline.


  ------Potential rebuilt table-parsing pipeline------ April 10 

 Goal

  Add a structure-normalization stage that repairs table outputs for blueprint schedules, specifically:

  - wrapped text misread as multiple rows
  - wide description columns split into multiple columns
  - section/header/spanning rows misread as normal data rows
  - variable-width columns and sparse columns

  This stage should sit after each parser method produces a grid, but before final cross-method merge.

  ———

  Pipeline Position

  Current rough flow:

  1. method parses region
  2. method returns headers, rows, optional boundaries
  3. mergeGrids() combines methods

  Proposed flow:

  1. method parses region
  2. method returns raw grid + geometry
  3. normalizeGridStructure(rawMethodResult, evidence)
  4. normalized per-method result
  5. mergeGrids(normalizedResults)

  For methods with weak geometry, normalization can still use text-only heuristics.
  For stronger methods, it should also use:

  - row boundaries
  - column boundaries
  - OCR word boxes
  - line evidence

  ———

  New Concepts

  Each row gets a type:

  - data
  - continuation
  - section
  - header
  - unknown

  Each column gets a role:

  - tag
  - qty
  - size
  - type
  - description
  - remarks
  - structured
  - unknown

  Each adjacent row pair gets a continuation score.

  Each adjacent column pair gets an anti-split merge score.

  ———

  Inputs

  For one parser result, normalization should take:

  - headers: string[]
  - rows: Record<string, string>[]
  - colBoundaries?: number[]
  - rowBoundaries?: number[]
  - method: string
  - confidence: number

  Optional evidence:

  - OCR words in region:
      - text
      - bbox
      - line grouping if available
  - line evidence:
      - vertical separators
      - horizontal separators
  - region bbox
  - source parser metadata if available

  ———

  Outputs

  Return same grid shape plus normalization metadata:

  - headers
  - rows
  - colBoundaries?
  - rowBoundaries?
  - normalization
      - rowTypes: RowType[]
      - columnRoles: ColumnRole[]
      - mergedRows: Array<{into: number, from: number}>
      - mergedColumns: Array<{intoLeft: number, fromRight: number}>
      - sectionRows: number[]
      - notes: string[]

  This metadata is useful both for debugging and UI explanations.

  ———

  Stage 1: Column Role Inference

  Infer likely semantic roles before row repair.

  For each column, compute features:

  - fillRate
  - avgTextLength
  - maxTextLength
  - numericRatio
  - shortTokenRatio
  - tagLikeRatio
  - multiWordRatio
  - rowsWithWrappedShape if OCR geometry exists
  - widthRatio if column boundaries exist

  Heuristics:

  tag

  - header matches: tag, mark, no, number, item, id
  - or >= 50% values match tag regex like D101, A-2, W03

  qty

  - header matches: qty, quantity
  - or mostly numeric short values

  size

  - header matches: size, width, height
  - or many dimension-like values (3'-0", 36x84, etc.)

  description / remarks

  - widest column by width ratio, or near-widest
  - highest average text length
  - highest multi-word ratio
  - often lower fill density but long cells
  - often contains punctuation/sentences

  structured

  - mostly short consistent entries
  - narrow or medium width
  - repeated token patterns

  If uncertain, keep unknown.

  Important:

  - allow multiple “text-heavy” columns, but prefer one main description column

  ———

  Stage 2: Row Feature Extraction

  For each row, compute:

  - nonEmptyCount
  - structuredNonEmptyCount
  - descriptionNonEmpty
  - descriptionTextLength
  - keyColumnsFilled
      - count of tag, qty, size, structured columns that are non-empty
  - allStructuredBlank
  - onlyDescriptionFilled
  - wideSpanLike
      - if one text-heavy column has content and most others are blank
  - tagLikePresent
  - numericDensity
  - lineGapAbove
  - lineGapBelow
  - hasSeparatorAbove
  - hasSeparatorBelow

  If OCR geometry exists, also compute:

  - text bbox union per row
  - per-column occupancy
  - indentation within description column
  - whether text lines align within a single wide column band

  ———

  Stage 3: Row Type Classification

  Classify each row.

  header

  - currently usually already implicit, but keep rule if needed
  - many header keyword matches
  - mostly short labels, not data values

  section

  - only one broad text-heavy column filled
  - most structured columns blank
  - text does not look like a normal item row
  - often uppercase phrase or category-like phrase
  - may span large horizontal width

  data

  - at least one key/structured column filled
  - row has a plausible item pattern

  continuation

  - likely belongs to prior row
  - structured columns mostly blank
  - description filled
  - geometry and spacing indicate continuation

  unknown

  - fallback

  Important:

  - do not finalize continuation until after pairwise continuation scoring with previous row

  ———

  Stage 4: Continuation Row Scoring

  For each adjacent row pair (A, B), compute continuationScore(A, B) in [0,1].

  Strong positive signals:

  - B has blank tag column and A has non-empty tag
  - B has blank qty/size/type columns
  - B has non-empty description/remarks text
  - A also has non-empty description/remarks text
  - small vertical gap between A and B
  - no strong horizontal separator line between A and B
  - OCR text in B sits within the same description column x-band as A
  - B is indented relative to A inside the description column
  - B has fewer filled columns than A
  - B text looks like sentence continuation:
      - lowercase start
      - punctuation continuation
      - no new item marker at start

  Negative signals:

  - B has its own tag-like value
  - B has numeric values in multiple structured columns
  - strong separator line exists
  - large vertical gap
  - B fills multiple non-description columns
  - B looks like a new section heading

  Example weighted score:

  - tag blank continuation signal: +0.20
  - multiple structured blanks: +0.20
  - description continues: +0.20
  - no separator line: +0.15
  - small gap: +0.10
  - same x-band / indent evidence: +0.10
  - textual continuation cues: +0.05

  Negative:

  - new tag/code: -0.40
  - strong separator line: -0.25
  - many structured values: -0.20

  Threshold:

  - >= 0.60 => merge B into A
  - 0.45 - 0.60 => flag ambiguous for diagnostics, no auto-merge
  - < 0.45 => keep separate

  ———

  Stage 5: Row Merge Operation

  When B is continuation of A:

  For each column:

  - if A[col] empty and B[col] non-empty, fill from B
  - if both non-empty and column role is text-heavy (description, remarks):
      - concatenate with newline or space
  - if both non-empty and column role is structured:
      - prefer A
      - keep disagreement note if values differ

  Then:

  - delete B
  - merge row metadata
  - mark A as data with mergedContinuationCount += 1

  Optional:

  - preserve original row indices for traceability

  ———

  Stage 6: Adjacent Column Anti-Split Scoring

  For each adjacent column pair (Cj, Cj+1), compute columnMergeScore.

  Strong positive signals:

  - both columns are text-heavy or unknown
  - neither behaves like a strong numeric/tag column
  - rows often populate one or the other, but not both simultaneously
  - combined column width is plausible as one wide description field
  - no strong vertical separator line between them
  - header row suggests one logical label across the pair
  - OCR word boxes across both columns form one contiguous text area
  - other methods produce fewer columns in that region

  Negative signals:

  - both columns are frequently populated independently in the same rows
  - strong vertical rule line exists between them
  - one column is clearly numeric/tag-like
  - headers clearly indicate two distinct fields

  Useful features:

  - coOccurrenceRate
      - how often both are filled in the same row
  - exclusiveOccupancyRate
      - how often exactly one is filled
  - textFragmentationRatio
      - whether values look like split phrase fragments
  - lineSeparatorStrength
  - crossMethodSupportForBoundary

  Threshold:

  - >= 0.65 => merge columns
  - 0.50 - 0.65 => ambiguous
  - < 0.50 => keep separate

  ———

  Stage 7: Column Merge Operation

  When merging Cj and Cj+1:

  - new header:
      - prefer non-generic header if one exists
      - if both generic, keep left
  - for each row:
      - if only one side populated, keep it
      - if both populated:
          - if both are text-heavy, concatenate with space
          - if one is likely a continuation fragment, concatenate
          - otherwise keep left and note disagreement
  - merge boundaries:
      - keep left boundary of Cj
      - keep right boundary of Cj+1
  - remove right column

  Repeat iteratively until no more merges exceed threshold.

  ———

  Stage 8: Section / Spanning Row Detection

  After row merges and column merges, detect rows that should not be treated as normal data rows.

  Section row signals:

  - only one text-heavy column populated
  - structured columns blank
  - text length medium/high
  - row spans visually broad area
  - no tag/qty pattern
  - maybe all-caps or category-like wording

  Mark row type as section.

  Why:

  - prevents these rows from polluting downstream tag mapping / QTO logic
  - allows UI to display hierarchy more honestly later

  ———

  Stage 9: Cross-Method Consensus Repair

  After each method is normalized, but before final merge:

  Compare grid shapes across methods.

  If one method has:

  - materially more rows than others, and extra rows are mostly continuation-like
    then collapse those rows before merge.

  If one method has:

  - materially more columns than others, and extra columns are low-confidence text fragments
    then collapse those columns before merge.

  This is not a full merge yet.
  It is a shape repair using other methods as sanity checks.

  Examples:

  - OCR says 12 rows, Textract/img2table say 8 rows
      - suspect wrapped-row oversegmentation
  - OCR says 7 cols, Textract/img2table/OpenCV say 5 cols
      - suspect wide-column split

  This should feed into blueprintparser_2%20copy/src/lib/grid-merger.ts, but as a repair stage before normal agreement
  scoring.

  ———

  Stage 10: Provenance and Explainability

  Every normalization action should emit structured reasons.

  Example:

  - merged row 6 into row 5: continuationScore=0.81, tag blank, qty blank, desc continues, no separator
  - merged col 3 and 4: columnMergeScore=0.74, no vertical separator, exclusive occupancy, long-text fragments

  This matters because:

  - you will need to debug real schedules
  - user trust improves if the system can explain why it merged rows/columns

  ———

  Suggested New Functions

  In practical code terms, I’d expect functions like:

  - inferColumnRoles(headers, rows, colBoundaries?)
  - extractRowFeatures(rows, columnRoles, geometry?)
  - scoreRowContinuation(prevRow, nextRow, context)
  - mergeContinuationRows(grid, context)
  - scoreAdjacentColumnMerge(leftCol, rightCol, context)
  - mergeSplitColumns(grid, context)
  - classifySectionRows(grid, context)
  - normalizeGridStructure(methodResult, evidence)
  - repairMethodShapeAgainstConsensus(methodResults)

  ———

  Minimal First Version

  If you want the smallest useful implementation first, do only these:

  1. infer one description column
  2. continuation-row scoring and merge
  3. adjacent-column anti-split for text-heavy columns
  4. section-row detection

  That alone would probably address most of:

  - wrapped sentences becoming new rows
  - wide description columns splitting
  - hierarchy rows getting flattened badly

  ———

  Success Criteria

  A normalization pass is successful if, on real schedules:

  - wrapped description text stays in one logical row
  - description/remarks columns stop splitting into multiple fake columns
  - section headings stop being mistaken for ordinary items
  - row/column counts converge more closely across methods
  - downstream tag mapping becomes more stable

  ———

  Bottom Line

  The parser should stop assuming:

  - every visual text line is a row
  - every repeated left edge is a column

  Instead it should infer:

  - logical rows
  - logical columns
  - continuation structure
  - spanning/section rows

  That is the algorithmic layer your blueprint schedules actually need.

  If you want, next I can turn this into:

  1. a file-by-file integration plan in your current codebase, or
  2. a pseudocode implementation sketch for normalizeGridStructure().

----

• Objective

  Build a schedule-normalization layer that makes Blueprint Parser robust on:

  - wrapped text rows
  - wide description/remarks columns
  - variable-width columns
  - section rows
  - floating / weak-grid schedules
  - multi-nested wonky schedules

  without turning the codebase into an unmaintainable parser blob.

  This doc assumes:

  - multiple raw parsing methods will continue to exist
  - different schedule types may ultimately need different parser strategies
  - the near-term goal is to normalize and repair outputs, not solve everything with one model

  ———

  Design Principles

  1. Separate extraction from interpretation

  - raw parsers detect structure candidates
  - normalizers repair those candidates into logical schedules
  - merger combines normalized candidates

  2. Preserve ambiguity

  - not every weird row should be forcibly flattened
  - ambiguous rows/columns should be marked, not silently destroyed

  3. Treat schedules as typed structures, not generic CSV

  - some rows are data
  - some are continuation
  - some are section
  - some may be group-header or spanning

  4. Use multiple parser families

  - line-based
  - OCR-layout-based
  - PDF-native
  - learned structure detectors
  - schedule-type-specific heuristics later if needed

  5. Make every repair explainable

  - if a row is merged, the system should know why
  - if columns collapse, the system should know why

  ———

  ## Proposed Architecture

  ### Layer 1: Raw Extraction

  Existing methods remain, with cleaner interfaces.

  Files:

  - blueprintparser_2%20copy/src/lib/services/table-parse.ts
  - blueprintparser_2%20copy/src/lib/img2table-extract.ts
  - blueprintparser_2%20copy/src/lib/camelot-extract.ts
  - blueprintparser_2%20copy/src/lib/tatr-structure.ts

  Responsibility:

  - produce a raw structural hypothesis
  - do not try to solve wrapped rows or nested hierarchy here
  - return geometry and confidence

  ### Layer 2: Normalization

  New core layer.

  Suggested files:

  - blueprintparser_2%20copy/src/lib/table-normalization.ts
  - blueprintparser_2%20copy/src/lib/table-normalization-types.ts
  - blueprintparser_2%20copy/src/lib/table-normalization-context.ts

  Responsibility:

  - infer semantic structure
  - merge wrapped rows
  - collapse fake split columns
  - classify row types
  - identify section/group/spanning rows
  - preserve notes and provenance

  ### Layer 3: Cross-Method Consensus

  This extends merger behavior.

  File:

  - blueprintparser_2%20copy/src/lib/grid-merger.ts

  Responsibility:

  - use normalized outputs, not just raw grid shapes
  - repair outlier methods
  - choose base grid from repaired candidates
  - preserve disagreements

  ### Layer 4: Optional Schedule-Type Routing

  Deferred, but the design should leave room for it.

  Possible future file:

  - blueprintparser_2%20copy/src/lib/table-profile-router.ts

  Responsibility:

  - classify schedule archetype:
      - strongly ruled
      - borderless
      - floating schedule
      - matrix schedule
      - nested/grouped schedule
  - bias which parsers and normalizers are emphasized

  This is the “multiple tools for different table types” idea. I think that idea is probably right long-term.

  ———

  ## Core Data Model

  Create explicit normalized types.

  ### In table-normalization-types.ts

  ColumnRole

  - tag
  - qty
  - size
  - type
  - description
  - remarks
  - structured
  - grouping
  - unknown

  RowType

  - header
  - data
  - continuation
  - section
  - group-header
  - spanning
  - unknown

  NormalizedCell

  - text
  - fragments?: string[]
  - sourceMethods?: string[]
  - confidence?: number

  NormalizedRow

  - type: RowType
  - cells: Record<string, NormalizedCell>
  - rawIndexSet: number[]
  - notes: string[]
  - confidence: number

  NormalizedGrid

  - headers: string[]
  - rows: NormalizedRow[]
  - columnRoles: ColumnRole[]
  - confidence: number
  - rowBoundaries?: number[]
  - colBoundaries?: number[]
  - repairs: RepairEvent[]
  - notes: string[]

  RepairEvent

  - kind
      - merge_row_continuation
      - merge_split_columns
      - mark_section_row
      - mark_group_header
      - consensus_shape_repair
  - reason
  - score
  - targets
  - method

  This is important because the current MethodResult is too weak for serious schedule logic.

  ———

  ## Proposed File Responsibilities

  ### 1. src/lib/table-normalization-types.ts

  Own:

  - all normalization domain types
  - no logic

  Reason:

  - keeps the rest of the implementation readable
  - avoids bloating grid-merger.ts

  ### 2. src/lib/table-normalization-context.ts

  Own:

  - feature extraction context
  - OCR word helpers
  - separator evidence helpers
  - geometric occupancy helpers

  Functions:

  - buildNormalizationContext(...)
  - getWordsInRegion(...)
  - getWordsInColumnBand(...)
  - hasHorizontalSeparatorBetween(...)
  - hasVerticalSeparatorBetween(...)
  - computeTextBandOccupancy(...)

  Inputs:

  - OCR words
  - region bbox
  - optional line evidence
  - optional parser geometry

  Reason:

  - normalization logic should not directly query raw OCR arrays everywhere
  - this file is the bridge from raw page evidence to semantic decisions

  ### 3. src/lib/table-normalization.ts

  Own:

  - orchestration of normalization
  - rule execution order
  - repair loop

  Suggested public API:

  - normalizeGridStructure(methodResult, context): NormalizedGrid
  - normalizeMethodResults(results, context): MethodResult[]

  Internal functions:

  - inferColumnRoles
  - extractRowFeatures
  - classifyInitialRowTypes
  - mergeContinuationRows
  - mergeSplitColumns
  - markSectionRows
  - markGroupHeaders
  - finalizeNormalizedGrid

  This should be the main “schedule interpretation engine.”

  ### 4. src/lib/grid-merger.ts

  Own:

  - cross-method comparison and merge
  - outlier-shape repair
  - final disagreement handling

  Changes:

  - accept normalized metadata when available
  - use columnRoles and rowTypes
  - add pre-merge shape consensus repair
  - preserve repair notes in merged output if useful

  Do not move all normalization here.
  Keep merger focused on cross-method integration.

  ### 5. src/app/api/table-parse/route.ts

  Own:

  - method execution
  - building normalization context
  - invoking normalization
  - calling merge

  Proposed sequence:

  1. load OCR + PDF/image assets
  2. run raw methods
  3. build normalization context from OCR words and line evidence
  4. normalize each method result
  5. merge normalized results
  6. return merged result + method diagnostics

  This should be the only place where all evidence sources meet.

  ### 6. src/lib/services/table-parse.ts

  Own:

  - raw method logic only
  - possibly richer raw geometry return values

  Do not add schedule interpretation here.
  Do consider returning more intermediate evidence:

  - OCR row clusters
  - column centers
  - weak boundary candidates

  This file should stay extraction-focused.

  ### 7. src/lib/img2table-extract.ts and scripts/img2table_extract.py

  Own:

  - direct upstream img2table integration
  - PDF-mode and image-mode extraction
  - preserving as much geometric output as possible

  Should return:

  - table bbox if possible
  - row boundaries / col boundaries
  - maybe per-cell geometry if possible
  - clear empty/error distinctions

  Do not teach it blueprint semantics.
  Let normalization do that.

  ### 8. src/lib/tatr-structure.ts and scripts/tatr_structure.py

  Own:

  - optional structure detector
  - rows/columns/cells as evidence

  This should stay isolated.
  Once working, it can later feed normalization as optional evidence, but not be required for it.

  ### 9. src/components/viewer/AutoParseTab.tsx

  Own:

  - parser diagnostics UI
  - method comparison
  - later, repair explanations

  Eventually show:

  - raw vs normalized row/column counts
  - “merged 3 continuation rows”
  - “collapsed 2 split columns”
  - section rows detected

  This will make debugging schedule classes much easier.

  ### 10. src/lib/__tests__/table-normalization.test.ts

  Own:

  - schedule-specific normalization tests

  This file will become one of the most important tests in the repo.

  ———

  ## Algorithm Modules and Function Signatures

  ### A. Column role inference

  In table-normalization.ts

  inferColumnRoles(headers, rows, boundaries, context)

  Outputs:

  - ColumnRole[]
  - role confidence per column
  - optional notes

  Key features:

  - header keyword matches
  - tag regex ratio
  - numeric ratio
  - avg text length
  - width ratio
  - multi-word ratio
  - punctuation ratio
  - occupancy patterns

  Elegant rule:

  - never hard-assign too early
  - use soft scores, then choose best role
  - allow fallback to structured or unknown

  ### B. Row feature extraction

  extractRowFeatures(grid, columnRoles, context)

  Outputs one feature object per row:

  - structuredFillCount
  - descriptionFill
  - tagPresent
  - numericDensity
  - spanPattern
  - separatorAbove
  - separatorBelow
  - indentation
  - textBandContinuity

  This becomes the backbone of all row decisions.

  ### C. Continuation merge

  mergeContinuationRows(grid, columnRoles, context)

  Algorithm:

  1. walk adjacent row pairs
  2. score continuation
  3. merge highest-confidence pairs
  4. recompute features after each pass
  5. repeat until stable

  Important:

  - use iterative repair, not just one pass
  - multi-line descriptions often require repeated collapsing

  ### D. Column anti-split repair

  mergeSplitColumns(grid, columnRoles, context)

  Algorithm:

  1. score each adjacent column pair
  2. merge only the strongest pair over threshold
  3. recompute features and roles
  4. repeat until stable

  Why iterative:

  - after collapsing one fake split, the next fake split becomes clearer

  ### E. Section / group-header detection

  markSectionRows(grid, columnRoles, context)

  Logic:

  - rows that occupy a broad textual span but little structured content
  - rows that look like category labels
  - rows that organize following child rows

  This is important for nested schedules.

  ### F. Nested/wonky table tolerance

  markGroupHeaders(grid, columnRoles, context)

  This is the first step toward multi-nested schedules.

  Examples:

  - “FRAME TYPES”
  - then child items under it
  - then “HARDWARE SETS”
  - then another child group

  You do not need full tree reconstruction at first.
  You just need not to destroy the grouping signal.

  ———

  ## Handling Multi-Nested Wonky Schedules

  This is where the design needs to stay elegant.

  I would not try to force all schedules into a pure rectangular table model.

  Instead, normalized rows should support:

  - type
  - indentLevel?
  - groupId?
  - parentGroupId?

  Not necessarily for UI immediately, but at least structurally.

  For example:

  - section
  - group-header
  - data
  - continuation

  This lets you preserve hierarchy even if export still flattens it later.

  A floating hardware schedule might become:

  - row 0: section
  - row 1: data
  - row 2: continuation
  - row 3: data
  - row 4: group-header
  - row 5: data

  That is much better than pretending every visual line is equivalent.

  ———

  ## Consensus Strategy Across Parsers

  This is where being creative helps.

  Do not think of methods as voting only on exact cells.
  Think of them as contributing structural evidence.

  Examples:

  - Textract/PDF mode may be best for column count
  - OCR positions may be best for text recovery
  - OpenCV may be best for ruling separators
  - TATR may later be useful for row/column hypotheses
  - img2table PDF may be best for borderless-ish native schedules

  So the merger should eventually support:

  - one method dominating column layout
  - another method dominating text filling
  - another method dominating separator evidence

  That is more elegant than “pick the highest confidence full grid.”

  ———

  ## Concrete Rollout Plan

  ### Milestone 1: Foundations

  Add:

  - table-normalization-types.ts
  - table-normalization-context.ts
  - table-normalization.ts

  Wire into:

  - blueprintparser_2%20copy/src/app/api/table-parse/route.ts
  - blueprintparser_2%20copy/src/lib/grid-merger.ts

  Implement only:

  - column role inference
  - continuation-row merge
  - section-row detection

  This should already help a lot.

  ### Milestone 2: Split-column repair

  Add:

  - adjacent-column anti-split logic
  - iterative column merge
  - consensus hints from other methods

  This is the major fix for wide description fields.

  ### Milestone 3: Schedule hierarchy preservation

  Add:

  - group-header
  - optional indentLevel
  - optional nested-group metadata

  Do not overcomplicate UI yet.
  Just preserve the information.

  ### Milestone 4: Method specialization

  Once img2table and TATR are alive:

  - compare schedule archetypes
  - introduce light routing/biasing by schedule type

  That is where multiple table-parsing tools for different table types becomes real.

  ———

  ## Testing Strategy

  ### Unit tests

  In:

  - blueprintparser_2%20copy/src/lib/__tests__/table-normalization.test.ts

  Test cases:

  - wrapped description row merges correctly
  - row with new tag does not merge
  - section row is detected
  - two fake split description columns merge
  - true adjacent structured columns do not merge
  - nested group header preserved

  ### Fixture strategy

  Create small synthetic normalized grids instead of only using PDFs.

  Why:

  - much easier to isolate logic
  - lets you encode ugly schedule patterns directly

  Later add a few real extracted fixtures from blueprints.

  ### Integration tests

  Extend route-level tests so /api/table-parse can be validated with mocked method outputs.

  This is important because the normalization layer sits between extraction and merge.

  ———

  ## What not to do

  - Do not bury normalization heuristics directly inside methodOcrPositions
  - Do not make grid-merger.ts own all schedule semantics
  - Do not make TATR a dependency for the normalization layer
  - Do not assume every schedule is rectangular
  - Do not expose 20 tuning knobs to users before default behavior is strong

  ———

  ## Bottom Line Design

  The elegant design here is:

  - raw parsers propose
  - normalizer interprets
  - merger reconciles
  - UI explains

  That gives you room for:

  - img2table
  - Textract
  - OpenCV
  - TATR
  - future schedule-specific parsers

  without turning the code into one giant unreadable chain of if-statements.

  If you want, next I can turn this into an even more concrete engineering artifact:

  1. exact proposed TypeScript interfaces, and
  2. pseudocode for normalizeGridStructure() plus the row/column scoring functions.




  