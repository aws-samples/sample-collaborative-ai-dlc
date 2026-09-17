variable "yjs_scaling" {
  description = "Yjs worker sizing, safeguards, and opt-in document sharding. Autoscaling requires cluster_enabled."
  type = object({
    cluster_enabled          = optional(bool, false)
    cpu                      = optional(number)
    memory                   = optional(number)
    desired_count            = optional(number, 1)
    max_connections          = optional(number, 2000)
    max_documents            = optional(number, 256)
    max_document_bytes       = optional(number, 8388608)
    max_total_document_bytes = optional(number, 67108864)
    max_buffered_bytes       = optional(number, 16777216)
    alarm_actions            = optional(list(string), [])
    autoscaling = optional(object({
      min_capacity = optional(number, 2)
      max_capacity = optional(number, 8)
    }))
  })
  default = {}
}
