package resiliencelab.server

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

/** Spring Boot configuration for the local resilience-lab API. */
@SpringBootApplication
class ResilienceLabApplication

/** Starts the resilience-lab server. */
fun main(args: Array<String>) {
    runApplication<ResilienceLabApplication>(*args)
}
