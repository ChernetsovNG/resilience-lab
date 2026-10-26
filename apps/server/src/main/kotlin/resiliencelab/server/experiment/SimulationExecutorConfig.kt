package resiliencelab.server.experiment

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor

/** Configures the bounded pool used to keep simulations off request threads. */
@Configuration(proxyBeanMethods = false)
class SimulationExecutorConfig {
    /** Creates a Spring-managed pool with bounded parallelism, queueing, and graceful shutdown. */
    @Bean
    fun simulationExecutor(): ThreadPoolTaskExecutor {
        val processors = Runtime.getRuntime().availableProcessors()
        return ThreadPoolTaskExecutor().apply {
            setCorePoolSize(processors)
            setMaxPoolSize(processors)
            setQueueCapacity(100)
            setThreadNamePrefix("simulation-")
            setWaitForTasksToCompleteOnShutdown(true)
            setAwaitTerminationSeconds(30)
        }
    }
}
