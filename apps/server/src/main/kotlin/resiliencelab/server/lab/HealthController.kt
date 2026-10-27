package resiliencelab.server.lab

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import resiliencelab.core.results.Versions

/** Exposes health information independently of jobs. */
@RestController
class HealthController {
    @GetMapping("/api/v1/health")
    fun health(): HealthView = HealthView("ok", Versions.APPLICATION, Versions.KSL)
}
