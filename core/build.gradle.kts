plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
}

kotlin {
    jvmToolchain(25)
}

dependencies {
    implementation("io.github.rossetti:KSLCore:R1.8.1")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    implementation("com.fasterxml.jackson.core:jackson-core:2.21.7")

    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}
