plugins {
    kotlin("jvm") version "2.4.21"
    application
}
kotlin { jvmToolchain(25) }
dependencies {
    implementation("io.github.rossetti:KSLCore:R1.8.1")
    testImplementation(kotlin("test"))
    testImplementation("org.assertj:assertj-core:3.27.7")
}
application { mainClass.set("resiliencelab.research.streams.MeasurementsKt") }
tasks.test { useJUnitPlatform() }
