package resiliencelab.server.api

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

/** Exposes health information independently of simulation jobs. */
@RestController
class HealthController {
    /** Returns application health and version information. */
    @GetMapping("/api/v1/health")
    fun health(): Map<String, String> =
        mapOf(
            "status" to "ok",
            "applicationVersion" to "0.1.0",
            "kslVersion" to "R1.8.1",
        )
}
