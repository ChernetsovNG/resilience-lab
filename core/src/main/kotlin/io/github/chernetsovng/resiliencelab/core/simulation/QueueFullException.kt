package io.github.chernetsovng.resiliencelab.core.simulation

class QueueFullException(val serviceId: String) :
    RuntimeException("Waiting queue is full for service '$serviceId'")
