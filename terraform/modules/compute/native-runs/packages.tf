# Package preparation depends only on source inputs. Keeping it outside the
# deployment modules prevents changing IAM policies from deferring filenames
# until apply, so every archive can be built and independently reviewed first.
module "packages" {
  source          = "terraform-aws-modules/lambda/aws"
  version         = "~> 8.0"
  for_each        = toset(["api", "worker", "execution-worker", "execution-credentials", "authority", "wakeup", "projection-worker", "result-worker"])
  create_function = false
  create_role     = false
  runtime         = "nodejs24.x"
  source_path = [{
    path     = local.source_path
    patterns = ["!.build/.*"]
    commands = [
      "cd ../.. && npm run build:${each.key} -w native-runtime-control",
      ":zip lambda/native-runtime-control/.build/${each.key}",
    ]
  }]
  hash_extra = sha256("${local.source_hash}:${filesha256("${path.module}/../../../../package-lock.json")}")
}
