plugins {
    kotlin("jvm") version "2.4.21"
    application
}
kotlin {
    jvmToolchain(25)
    sourceSets.named("main") { kotlin.srcDir("../ksl-capabilities/src/main/kotlin") }
}
dependencies {
    implementation("resiliencelab:core")
    implementation("io.github.rossetti:KSLCore:R1.8.1")
    implementation("com.datadoghq:sketches-java:0.8.3")
    implementation("org.openjdk.jol:jol-core:0.17")
}
application {
    mainClass.set("resiliencelab.research.latency.BenchmarkKt")
    // Object layout estimates need neither dynamic instrumentation nor the privileged SA helper.
    applicationDefaultJvmArgs = listOf("-Xms512m", "-Xmx4g", "-XX:+UseG1GC",
        "-Djol.skipDynamicAttach=true", "-Djol.skipHotspotSAAttach=true")
}
