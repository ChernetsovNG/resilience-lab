plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
}

kotlin {
    jvmToolchain(25)
}

dependencies {
    implementation("io.github.rossetti:KSLCore:R1.8.1")
    implementation("com.datadoghq:sketches-java:0.8.3")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-schema-generator-json:0.6.0") {
        // Reuse KSL's logger: kotlin-logging 8 adds initialization chatter to the CLI's stdout.
        exclude(group = "io.github.oshai", module = "kotlin-logging")
    }
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    implementation("com.fasterxml.jackson.core:jackson-core:2.21.7")

    testImplementation(kotlin("test"))
    testImplementation("com.networknt:json-schema-validator:1.5.6")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("resilience-lab.project-root", "..")
    inputs
        .files(rootProject.fileTree("schemas") { include("*.schema.json") })
        .withPropertyName("documentSchemas")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    inputs
        .dir(rootProject.file("examples"))
        .withPropertyName("exampleWorkspace")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    inputs
        .files(rootProject.fileTree("web/src/results/series/fixtures") { include("*.json") })
        .withPropertyName("webSeriesFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    inputs
        .file(rootProject.file("web/src/test/catalog.json"))
        .withPropertyName("webCatalog")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    inputs
        .dir("src/main/kotlin")
        .withPropertyName("contractSources")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}
