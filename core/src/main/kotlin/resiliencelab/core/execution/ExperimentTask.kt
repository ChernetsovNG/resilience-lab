package resiliencelab.core.execution

/** Stable address of one variant × grid point × replication task. */
internal data class ExperimentTask(
    val variant: String,
    val point: String,
    val replication: Int,
) {
    fun directory(runDirectory: String): String = "$runDirectory/series/$variant/$point/rep-$replication"
}
