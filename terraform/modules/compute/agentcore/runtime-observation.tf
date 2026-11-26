# AWSCC 1.94 retains the previous computed runtime version during an update.
# Read the completed resource separately so consumers receive the new version.
# The explicit dependency defers this read even when the runtime ID is unchanged.
data "awscc_bedrockagentcore_runtime" "stage_executor_observed" {
  id         = awscc_bedrockagentcore_runtime.stage_executor.id
  depends_on = [awscc_bedrockagentcore_runtime.stage_executor]

  lifecycle {
    postcondition {
      condition = try(
        self.status == "READY" &&
        can(regex("^[1-9][0-9]{0,4}$", self.agent_runtime_version)),
        false,
      )
      error_message = "The shared AgentCore runtime must be READY with a valid observed version."
    }

    postcondition {
      condition = try(
        self.agent_runtime_id == awscc_bedrockagentcore_runtime.stage_executor.agent_runtime_id &&
        self.agent_runtime_arn == awscc_bedrockagentcore_runtime.stage_executor.agent_runtime_arn &&
        self.agent_runtime_name == awscc_bedrockagentcore_runtime.stage_executor.agent_runtime_name,
        false,
      )
      error_message = "The observed shared AgentCore runtime identity does not match the managed runtime."
    }

    postcondition {
      condition = try(
        self.agent_runtime_artifact.container_configuration.container_uri == awscc_bedrockagentcore_runtime.stage_executor.agent_runtime_artifact.container_configuration.container_uri &&
        self.agent_runtime_artifact.code_configuration == null,
        false,
      )
      error_message = "The observed shared AgentCore runtime does not use the desired container image."
    }

    postcondition {
      condition = try(
        self.environment_variables == awscc_bedrockagentcore_runtime.stage_executor.environment_variables &&
        self.role_arn == awscc_bedrockagentcore_runtime.stage_executor.role_arn,
        false,
      )
      error_message = "The observed shared AgentCore runtime environment or execution role does not match the desired configuration."
    }
  }
}
