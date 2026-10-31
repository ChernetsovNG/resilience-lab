package resiliencelab.core.ir

/** Router-owned consecutive-failure policy; ejection duration grows by [baseEjectionMs] on each ejection. */
data class OutlierDetectionConfig(
    val consecutiveFailures: Int,
    val baseEjectionMs: Double,
    val maxEjected: Double,
)
