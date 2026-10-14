"""Offline architectural guards; no Terraform plan, AWS, or model invocation.

Terraform validate checks the real HCL/module graph. These checks separately
guard permission boundaries and wiring against accidental capability expansion.
Run with:
  PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
    -s terraform/modules/compute/native-runs/tests -p 'test_*.py'
"""
import json
from fnmatch import fnmatchcase
from pathlib import Path
import re
import unittest


MODULE = Path(__file__).resolve().parents[1]
TERRAFORM = MODULE.parents[2]
REPO = TERRAFORM.parent
EXECUTION = (MODULE / "execution.tf").read_text()
MAIN = (MODULE / "main.tf").read_text()
ROOT = (TERRAFORM / "native-runtime-preparation.tf").read_text()
ROUTES = (TERRAFORM / "modules/api/native-intents.tf").read_text()
GATEWAY = (TERRAFORM / "modules/api/main.tf").read_text()


def block(source, header):
    # Top-level blocks are column-zero after terraform fmt. None of the
    # inspected blocks contains heredocs; nested closes remain indented.
    found = re.search(r"^" + re.escape(header) + r"\s*\{(.*?)^\}", source, re.M | re.S)
    if found is None:
        raise AssertionError(f"Missing block: {header}")
    return found.group(1)


def actions(source):
    return set(
        action
        for field in re.findall(r"\bAction\s*=\s*(\[[^\]]*\]|\"[^\"]*\")", source, re.S)
        for action in re.findall(r'"([^"]+)"', field)
    )

def has_control_mutation(source):
    return any(
        fnmatchcase(required, allowed)
        for allowed in actions(source)
        for required in [
            "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
            "dynamodb:TransactWriteItems", "dynamodb:BatchWriteItem",
        ]
    )

def permits_s3(source, action, key):
    """Evaluate this module's explicit S3 Allow action/resource pairs offline."""
    resource = f"arn:aws:s3:::test-publications/{key}"
    pairs = re.findall(
        r"\bAction\s*=\s*(\[[^\]]*\]|\"[^\"]*\")\s+Resource\s*=\s*(\[[^\]]*\]|\"[^\"]*\")",
        source,
        re.S,
    )
    return any(
        any(fnmatchcase(action, allowed) for allowed in re.findall(r'"([^"]+)"', action_field))
        and any(
            fnmatchcase(resource, pattern.replace(
                "${aws_s3_bucket.publications.arn}", "arn:aws:s3:::test-publications",
            ))
            for pattern in re.findall(r'"([^"]+)"', resource_field)
        )
        for action_field, resource_field in pairs
    )


class NativeExecutionWiring(unittest.TestCase):
    def test_only_native_authority_can_mutate_control_records(self):
        projection = (MODULE / "projection.tf").read_text()
        wakeup = (MODULE / "wakeup.tf").read_text()
        for source, header in [
            (MAIN, 'resource "aws_iam_role_policy" "api"'),
            (MAIN, 'resource "aws_iam_role_policy" "worker"'),
            (EXECUTION, 'resource "aws_iam_role_policy" "execution_worker"'),
            (projection, 'resource "aws_iam_role_policy" "projection"'),
            (wakeup, 'resource "aws_iam_role_policy" "wakeup"'),
        ]:
            with self.subTest(role=header):
                self.assertFalse(has_control_mutation(block(source, header)))
        authority = (MODULE / "authority.tf").read_text()
        self.assertTrue(has_control_mutation(authority))
        self.assertIn('"dynamodb:LeadingKeys" = ["NATIVE#*"]', authority)
        self.assertNotIn('NATIVE_RUNTIME_IMAGE#', authority)
        # The credential reader retains rotation writes to credential tables.
        # Its only native-control grant is the independently checked read.
        credentials = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_credentials"')
        native_read = credentials.split('Sid      = "ReadNativeExecutionAuthority"', 1)[1].split("},", 1)[0]
        self.assertEqual(actions(native_read), {"dynamodb:GetItem"})
        self.assertEqual(credentials.count("aws_dynamodb_table.bindings.arn"), 1)

    def test_repair_checkpoint_writer_is_separate_from_control_authority(self):
        source = (MODULE / "wakeup.tf").read_text()
        checkpoint = block(source, 'resource "aws_iam_role_policy" "wakeup_checkpoint"')
        self.assertEqual(actions(checkpoint), {"dynamodb:GetItem", "dynamodb:PutItem"})
        self.assertIn('Resource = var.native_repair_table_arn', checkpoint)
        self.assertIn('"dynamodb:LeadingKeys" = ["runtime"]', checkpoint)
        self.assertNotIn('aws_dynamodb_table.bindings', checkpoint)
        self.assertNotIn('package_jobs', checkpoint)

    def test_control_mutation_guard_rejects_wildcards_and_single_item_bypasses(self):
        for action in ["*", "dynamodb:*", "dynamodb:Put*", "dynamodb:UpdateItem", "dynamodb:TransactWriteItems"]:
            self.assertTrue(has_control_mutation(f'Action = ["{action}"]'))
        self.assertFalse(has_control_mutation('Action = ["dynamodb:GetItem", "dynamodb:Query"]'))

    def test_adapters_can_invoke_only_their_authority_alias(self):
        api = block(MAIN, 'resource "aws_iam_role_policy" "api"')
        preparation = block(MAIN, 'resource "aws_iam_role_policy" "worker"')
        execution = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_worker"')
        projection = block((MODULE / "projection.tf").read_text(), 'resource "aws_iam_role_policy" "projection"')
        for name, source in [("commands", api), ("preparation", preparation), ("execution", execution), ("projection", projection)]:
            aliases = re.findall(r'NATIVE_AUTHORITY_FUNCTION\}:([^"]+)"', source)
            self.assertEqual(aliases, [name])

    def test_only_execution_poller_allows_intentional_lambda_recursion(self):
        # The deployed first turn lost its status pointer to Lambda's recursion
        # cutoff. Allow only this deliberately self-scheduling controller.
        worker = block(EXECUTION, 'module "execution_worker"')
        self.assertRegex(worker, r'\brecursive_loop\s*=\s*"Allow"')
        for source, header in [
            (EXECUTION, 'module "execution_credentials"'),
            (MAIN, 'module "api"'),
            (MAIN, 'module "worker"'),
        ]:
            with self.subTest(module=header):
                self.assertNotRegex(block(source, header), r'\brecursive_loop\s*=\s*"Allow"')

    def test_root_opt_in_requires_same_dev_preparation_and_package_pilot(self):
        switch = block(ROOT, 'variable "enable_native_execution"')
        self.assertRegex(switch, r"default\s*=\s*false")
        guard = block(ROOT, 'resource "terraform_data" "native_execution_configuration"')
        for required in [
            'var.environment == "dev"', "var.enable_native_preparation",
            "var.enable_native_workflow_sources", "var.enable_native_package_jobs",
            "length(var.native_preparation_project_ids) > 0",
        ]:
            self.assertIn(required, guard)
        self.assertRegex(ROOT, r"project_ids\s*=\s*var.native_preparation_project_ids")
        self.assertRegex(ROOT, r"image_digest\s*=\s*module.agentcore.image_digest")

    def test_publications_survive_execution_disable_and_have_no_expiration(self):
        bucket = block(EXECUTION, 'resource "aws_s3_bucket" "publications"')
        self.assertRegex(bucket, r"force_destroy\s*=\s*false")
        self.assertNotRegex(bucket, r"\b(count|for_each)\s*=")
        self.assertIn('status = "Enabled"', EXECUTION)
        self.assertIn('sse_algorithm = "AES256"', EXECUTION)
        self.assertIn('object_ownership = "BucketOwnerEnforced"', EXECUTION)
        public = block(EXECUTION, 'resource "aws_s3_bucket_public_access_block" "publications"')
        for setting in ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"]:
            self.assertRegex(public, rf"{setting}\s*=\s*true")
        for source in MODULE.glob("*.tf"):
            self.assertNotIn('resource "aws_s3_bucket_lifecycle_configuration"', source.read_text())
        policy = block(EXECUTION, 'resource "aws_s3_bucket_policy" "publications"')
        self.assertNotRegex(policy, r'Effect\s*=\s*"Allow"')
        self.assertIn('"aws:SecureTransport" = "false"', policy)

    def test_runtime_boundary_extends_only_scoped_s3_access(self):
        boundary = block(MAIN, 'resource "aws_iam_policy" "runtime_boundary"')
        self.assertIn("local.execution_runtime_boundary_statements", boundary)
        self.assertNotIn("var.execution_enabled ?", boundary)
        extension = EXECUTION.split("execution_runtime_boundary_statements = [", 1)[1].split("\n}\n", 1)[0]
        self.assertEqual(actions(extension), {"s3:GetObjectVersion", "s3:PutObject", "s3:GetObject"})
        self.assertIn("${var.native_packages_bucket_arn}/native-packages/v1/*", extension)
        self.assertIn("${aws_s3_bucket.publications.arn}/native-executions/*", extension)
        self.assertFalse(any(
            action.startswith(("dynamodb:", "lambda:", "ssm:", "secretsmanager:", "neptune-db:"))
            for action in actions(boundary) | actions(extension)
        ))

    def test_api_cannot_redeem_credentials_or_write_publications(self):
        api = EXECUTION.split("execution_api_statements = [", 1)[1].split("execution_runtime_boundary_statements = [", 1)[0]
        self.assertEqual(actions(api), {
            "dynamodb:GetItem", "dynamodb:Query", "ssm:GetParameter",
            "lambda:InvokeFunction", "s3:GetObjectVersion", "sqs:SendMessage",
        })
        # Output history queries are restricted to the protected native table.
        self.assertRegex(api, r'Sid\s*=\s*"ReadNativeOutputHistory"[^}]*Action\s*=\s*\["dynamodb:Query"\][^}]*Resource\s*=\s*aws_dynamodb_table\.bindings\.arn')
        self.assertNotIn("dynamodb:Scan", actions(api))
        self.assertIn("var.agent_credential_metadata_function_arn", api)
        self.assertNotIn("module.execution_credentials", api)
        self.assertIn('"${local.ssm_prefix_arn}/cli-models"', api)
        self.assertIn('"${local.ssm_prefix_arn}/tier-models"', api)
        self.assertNotIn("bedrock-bearer-token", api)

    def test_private_recovery_bytes_are_not_member_artifacts_or_runtime_authority(self):
        extension = EXECUTION.split("execution_runtime_boundary_statements = [", 1)[1].split("\n}\n", 1)[0]
        runtime = block(MAIN, 'resource "aws_iam_policy" "runtime_boundary"') + extension
        worker = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_worker"')
        api = block(MAIN, 'resource "aws_iam_role_policy" "api"') + EXECUTION.split(
            "execution_api_statements = [", 1,
        )[1].split("execution_runtime_boundary_statements = [", 1)[0]
        checkpoint = "native-recovery/v1/scope/attempt/1/manifests/hash.json"
        for action in ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]:
            self.assertTrue(permits_s3(runtime, action, checkpoint))
            self.assertFalse(permits_s3(api, action, checkpoint))
        self.assertTrue(permits_s3(worker, "s3:GetObjectVersion", checkpoint))
        for action in ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]:
            self.assertFalse(permits_s3(worker, action, checkpoint))
        for action in ["s3:DeleteObject", "s3:DeleteObjectVersion"]:
            self.assertFalse(permits_s3(runtime, action, checkpoint))

    def test_worker_can_control_existing_native_runs_but_cannot_create_resources(self):
        worker = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_worker"')
        allowed = actions(worker)
        self.assertTrue({
            "dynamodb:GetItem",
            "bedrock-agentcore:UpdateAgentRuntime", "bedrock-agentcore:StopRuntimeSession",
            "bedrock-agentcore:InvokeAgentRuntime", "lambda:InvokeFunction",
            "neptune-db:ReadDataViaQuery",
        } <= allowed)
        self.assertFalse({
            "iam:CreateRole", "elasticfilesystem:CreateAccessPoint",
            "bedrock-agentcore:CreateAgentRuntime", "ssm:GetParameter",
            "secretsmanager:GetSecretValue", "dynamodb:PutItem", "dynamodb:ConditionCheckItem",
            "neptune-db:WriteDataViaQuery", "neptune-db:DeleteDataViaQuery",
        } & allowed)
        self.assertIn("module.execution_credentials[0].lambda_function_arn", worker)
        self.assertNotIn("credential_broker", worker)
        self.assertIn('Resource = local.role_arn', worker)
        self.assertIn('"iam:PassedToService"', worker)
        self.assertIn("aws_efs_file_system.runs.arn", worker)
        self.assertEqual(
            {a for a in allowed if a.startswith("elasticfilesystem:")},
            {"elasticfilesystem:DescribeAccessPoints"},
        )

    def test_projection_property_replacement_has_cluster_scoped_delete_only_on_controller(self):
        # Neptune requires Read/Write/DeleteDataViaQuery for property(), including
        # cardinality.single replacing a value. Read+Write alone denied the first
        # native projection even though publication and serialization succeeded.
        worker = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_worker"')
        projection = block((MODULE / "projection.tf").read_text(), 'resource "aws_iam_role_policy" "projection"')
        self.assertTrue({
            "neptune-db:connect", "neptune-db:ReadDataViaQuery",
            "neptune-db:WriteDataViaQuery", "neptune-db:DeleteDataViaQuery",
        } <= actions(projection))
        self.assertNotIn("neptune-db:WriteDataViaQuery", actions(worker))
        self.assertIn("local.graph_arn", projection)
        api_extension, runtime_extension = EXECUTION.split(
            "execution_api_statements = [", 1,
        )[1].split("execution_runtime_boundary_statements = [", 1)
        runtime_extension = runtime_extension.split("\n}\n", 1)[0]
        for name, policy in [
            ("api", block(MAIN, 'resource "aws_iam_role_policy" "api"') + api_extension),
            ("preparation", block(MAIN, 'resource "aws_iam_role_policy" "worker"')),
            ("credentials", block(EXECUTION, 'resource "aws_iam_role_policy" "execution_credentials"')),
            ("runtime", block(MAIN, 'resource "aws_iam_policy" "runtime_boundary"') + runtime_extension),
        ]:
            with self.subTest(policy=name):
                self.assertFalse({
                    "neptune-db:WriteDataViaQuery", "neptune-db:DeleteDataViaQuery",
                } & actions(policy))
                if name == "runtime":
                    self.assertFalse(any(action.startswith("neptune-db:") for action in actions(policy)))

    def test_runtime_can_read_latest_fence_but_cannot_write_delete_or_read_old_fence_versions(self):
        extension = EXECUTION.split("execution_runtime_boundary_statements = [", 1)[1].split("\n}\n", 1)[0]
        runtime = block(MAIN, 'resource "aws_iam_policy" "runtime_boundary"') + extension
        fence = "native-execution-control/v1/" + "a" * 64 + "/attempt-one/state.json"
        artifact = "native-executions/v1/" + "a" * 64 + "/attempt-one/1/files/file-one"
        self.assertTrue(permits_s3(runtime, "s3:GetObject", fence))
        for action in ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:GetObjectVersion"]:
            with self.subTest(action=action):
                self.assertFalse(permits_s3(runtime, action, fence))
        self.assertTrue(permits_s3(runtime, "s3:PutObject", artifact))
        self.assertTrue(permits_s3(runtime, "s3:GetObjectVersion", artifact))
        self.assertFalse(permits_s3(runtime, "s3:GetObject", artifact))
        self.assertFalse(permits_s3(runtime, "s3:GetObject", "native-execution-control/v2/scope/state.json"))
        self.assertFalse(permits_s3(runtime, "s3:GetObject", "other-prefix/state.json"))

    def test_only_worker_has_fence_write_access_and_cannot_delete_fences_or_write_publications(self):
        worker = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_worker"')
        api = block(MAIN, 'resource "aws_iam_role_policy" "api"') + EXECUTION.split(
            "execution_api_statements = [", 1,
        )[1].split("execution_runtime_boundary_statements = [", 1)[0]
        facade = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_credentials"')
        preparation_worker = block(MAIN, 'resource "aws_iam_role_policy" "worker"')
        fence = "native-execution-control/v1/scope/attempt/state.json"
        self.assertTrue(permits_s3(worker, "s3:GetObject", fence))
        self.assertTrue(permits_s3(worker, "s3:PutObject", fence))
        for action in ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:GetObjectVersion"]:
            self.assertFalse(permits_s3(worker, action, fence))
        self.assertFalse(permits_s3(worker, "s3:PutObject", "native-executions/v1/scope/manifest.json"))
        self.assertFalse(permits_s3(worker, "s3:PutObject", "native-execution-control/v2/scope/state.json"))
        self.assertFalse(permits_s3(worker, "s3:PutObject", "unrelated/state.json"))
        for source in [api, facade, preparation_worker]:
            for action in ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]:
                self.assertFalse(permits_s3(source, action, fence))

    def test_missing_fence_lookup_can_return_404_only_to_the_controller(self):
        worker = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_worker"')
        lookup = worker.split(
            'Sid      = "DistinguishMissingNativeControlRecords"', 1,
        )[1].split("},", 1)[0]
        self.assertEqual(actions(lookup), {"s3:ListBucket"})
        self.assertRegex(lookup, r'Effect\s*=\s*"Allow"')
        self.assertRegex(lookup, r"Resource\s*=\s*aws_s3_bucket\.publications\.arn\s*$")
        # A prefix-conditioned ListBucket grant is not an unconditional bucket
        # permission for GetObject's missing-key authorization check.
        self.assertNotIn("Condition", lookup)
        self.assertEqual(EXECUTION.count('"s3:ListBucket"'), 1)
        api, runtime = EXECUTION.split("execution_api_statements = [", 1)[1].split(
            "execution_runtime_boundary_statements = [", 1,
        )
        runtime = runtime.split("\n}\n", 1)[0]
        self.assertNotIn("s3:ListBucket", actions(api) | actions(runtime))

    def test_facade_has_separate_role_read_only_authority_and_rotation_dependencies(self):
        facade = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_credentials"')
        self.assertFalse({
            "lambda:InvokeFunction", "neptune-db:WriteDataViaQuery",
            "s3:PutObject", "s3:GetObjectVersion",
        } & actions(facade))
        self.assertNotIn("credential_grant_secret", EXECUTION)
        self.assertNotIn("v2_executions_table", facade)
        authority = facade.split('Sid      = "ReadNativeExecutionAuthority"', 1)[1].split("},", 1)[0]
        self.assertEqual(actions(authority), {"dynamodb:GetItem"})
        for dependency in [
            "var.git_connections_table_arn", "var.git_provider_connections_table_arn",
            "var.source_control_bindings_table_arn", "var.github_app_config_param_arn",
            "var.github_app_private_key_secret_arn", "var.gitlab_oauth_secret_arn",
            "var.bitbucket_oauth_secret_arn", '${local.ssm_prefix_arn}/git-token/*',
        ]:
            self.assertIn(dependency, facade)
        for source in MODULE.glob("*.tf"):
            self.assertNotIn('resource "aws_lambda_function_url"', source.read_text())
            self.assertNotIn('resource "aws_lambda_permission" "execution_credentials', source.read_text())

    def test_access_point_id_lookup_requires_native_resource_tags_and_keeps_filesystem_scope(self):
        worker = block(EXECUTION, 'resource "aws_iam_role_policy" "execution_worker"')
        filesystem = worker.split('Sid      = "VerifyNativeFilesystemAccessPoints"', 1)[1].split("},", 1)[0]
        self.assertEqual(actions(filesystem), {"elasticfilesystem:DescribeAccessPoints"})
        self.assertIn("Resource = aws_efs_file_system.runs.arn", filesystem)
        access_point = worker.split('Sid      = "VerifyTaggedNativeAccessPoint"', 1)[1]
        self.assertEqual(actions(access_point), {"elasticfilesystem:DescribeAccessPoints"})
        self.assertIn(
            'Resource = "arn:${local.partition}:elasticfilesystem:${local.region}:${local.account_id}:access-point/fsap-*"',
            access_point,
        )
        for tag in ["NativeBinding", "NativeScope"]:
            self.assertRegex(access_point, rf'"aws:ResourceTag/{tag}"\s*=\s*"false"')
        self.assertIn('"????????-????-4???-????-????????????"', access_point)
        self.assertIn('"' + "?" * 64 + '"', access_point)
        self.assertNotRegex(access_point, r'\bResource\s*=\s*"\*"')

    def test_new_lambdas_have_control_only_budgets_vpc_and_disabled_event_logging(self):
        for name, handler, timeout in [
            ("execution_worker", "execution-worker.handler", 120),
            ("execution_credentials", "execution-credentials-entry.handler", 60),
        ]:
            with self.subTest(name=name):
                function = block(EXECUTION, f'module "{name}"')
                for pattern in [
                    rf'handler\s*=\s*"{handler}"', r'runtime\s*=\s*"nodejs24.x"',
                    r'architectures\s*=\s*\["arm64"\]', r'memory_size\s*=\s*512',
                    rf'timeout\s*=\s*{timeout}', r'count\s*=\s*1',
                    r'vpc_subnet_ids\s*=\s*var.api_subnet_ids',
                    r'vpc_security_group_ids\s*=\s*var.api_security_group_ids',
                    r'POWERTOOLS_LOGGER_LOG_EVENT\s*=\s*"false"',
                ]:
                    self.assertRegex(function, pattern)
                self.assertIn(f"aws_iam_role.{name}[0].arn", function)

    def test_queue_has_no_receive_count_cutoff_and_preserves_preparation_queue(self):
        queue = block(EXECUTION, 'resource "aws_sqs_queue" "execution"')
        self.assertRegex(queue, r"visibility_timeout_seconds\s*=\s*720")
        self.assertNotRegex(queue, r"\b(redrive_policy|maxReceiveCount)\b")
        self.assertRegex(queue, r"sqs_managed_sse_enabled\s*=\s*true")
        mapping = block(EXECUTION, 'resource "aws_lambda_event_source_mapping" "execution"')
        self.assertRegex(mapping, r"batch_size\s*=\s*1")
        self.assertIn('"ReportBatchItemFailures"', mapping)
        preparation = block(MAIN, 'module "worker"')
        self.assertRegex(preparation, r'handler\s*=\s*"worker.handler"')
        self.assertRegex(preparation, r"environment_variables\s*=\s*local.base_environment")

    def test_execution_routes_use_existing_authenticated_deployment_and_cors_closure(self):
        for path in ["start", "cancel", "publication", "graph", "files/*", "interaction", "response", "prompt"]:
            self.assertIn(f'path   = "api/projects/*/native-intents/*/{path}"', ROUTES)
        self.assertRegex(ROUTES, r'authorization\s*=\s*"COGNITO_USER_POOLS"')
        self.assertIn('"method.request.path.fileId" = true', ROUTES)
        self.assertIn("module.cors_native_execution_action, module.cors_native_execution_file", ROUTES)
        self.assertIn("module.cors_native_intent_prompt", ROUTES)
        self.assertIn("module.cors_native_intent_prompt", GATEWAY)
        self.assertIn('resource "aws_api_gateway_resource" "native_intent_prompt"', ROUTES)
        self.assertIn("aws_api_gateway_integration.native_intents,", GATEWAY)
        self.assertIn("for key, method in aws_api_gateway_method.native_intents", GATEWAY)
        self.assertIn("for key, integration in aws_api_gateway_integration.native_intents", GATEWAY)
        self.assertNotIn("execution_credentials", ROUTES)

    def test_interactions_use_publication_storage_but_human_authority_remains_protected(self):
        extension = EXECUTION.split("execution_runtime_boundary_statements = [", 1)[1].split("\n}\n", 1)[0]
        runtime = block(MAIN, 'resource "aws_iam_policy" "runtime_boundary"') + extension
        interaction = "native-executions/v1/scope/attempt/1/interactions/" + "a" * 64 + ".json"
        self.assertTrue(permits_s3(runtime, "s3:PutObject", interaction))
        self.assertTrue(permits_s3(runtime, "s3:GetObjectVersion", interaction))
        self.assertFalse(permits_s3(runtime, "s3:DeleteObject", interaction))
        self.assertFalse(any(action.startswith("dynamodb:") for action in actions(runtime)))
        for name in ["interaction", "response"]:
            self.assertIn(f'aws_api_gateway_resource.native_execution_action["{name}"].id', ROUTES)
        routes = block(ROUTES, "locals")
        self.assertRegex(routes, r'interaction\s*=\s*\{\s*method\s*=\s*"GET"')
        self.assertRegex(routes, r'response\s*=\s*\{\s*method\s*=\s*"POST"')

    def test_build_targets_match_handlers_and_sdk_versions(self):
        package = json.loads((REPO / "lambda/native-runtime-control/package.json").read_text())
        for package_name in ["client-s3", "client-ssm", "client-lambda", "client-secrets-manager"]:
            self.assertEqual(package["dependencies"][f"@aws-sdk/{package_name}"], "^3.1092.0")
        for target, entry in [
            ("execution-worker", "execution-worker"),
            ("execution-credentials", "execution-credentials-entry"),
        ]:
            command = package["scripts"][f"build:{target}"]
            self.assertIn(f"{entry}.js --bundle", command)
            self.assertIn("--format=esm", command)
            self.assertIn(f"--outfile=.build/{target}/{entry}.mjs", command)


if __name__ == "__main__":
    unittest.main()
