plugins {
    kotlin("jvm") version "2.4.21"
    kotlin("plugin.serialization") version "2.4.21"
    application
}
kotlin { jvmToolchain(25) }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-schema-generator-json:0.6.0")
    implementation("com.charleskorn.kaml:kaml:0.104.0")
    implementation("org.snakeyaml:snakeyaml-engine:3.2")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.21.7")
    implementation("com.github.victools:jsonschema-generator:4.38.0")
    implementation("com.github.victools:jsonschema-module-jackson:4.38.0")
    implementation("org.assertj:assertj-core:3.27.7")
}
dependencyLocking { lockAllConfigurations() }
application { mainClass.set("resiliencelab.research.ProbeKt") }
tasks.named<JavaExec>("run") { workingDir = projectDir }
