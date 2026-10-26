package resiliencelab.core.simulation

/** Signals immediate rejection when an attempt cannot enter a service's bounded waiting queue. */
class QueueFullException(val serviceId: String) :
    RuntimeException("Waiting queue is full for service '$serviceId'")
