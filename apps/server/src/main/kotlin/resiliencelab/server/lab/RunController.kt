package resiliencelab.server.lab

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.results.RunCatalog
import resiliencelab.core.results.RunEntry
import resiliencelab.core.results.RunManifest
import resiliencelab.core.results.RunSummary
import java.io.IOException

/** Finished runs from `.results/` (ADR 0008); they outlive server restarts, jobs do not. */
@RestController
@RequestMapping("/api/v1/runs")
class RunController(
    private val runs: RunCatalog,
) {
    @GetMapping
    @Throws(IOException::class)
    fun listRuns(): List<RunEntry> = runs.list()

    @GetMapping("/{id}/manifest")
    @Throws(IOException::class)
    fun getRunManifest(
        @PathVariable id: String,
    ): RunManifest = runs.manifest(id) ?: throw notFound(id)

    @GetMapping("/{id}/summary")
    @Throws(IOException::class)
    fun getRunSummary(
        @PathVariable id: String,
    ): RunSummary = runs.summary(id) ?: throw notFound(id)

    private fun notFound(id: String) = NotFound("RUN_NOT_FOUND", "Run '$id' does not exist")
}
