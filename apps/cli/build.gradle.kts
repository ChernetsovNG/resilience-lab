plugins {
    kotlin("jvm")
    application
}

kotlin {
    jvmToolchain(25)
}

dependencies {
    implementation(project(":core"))
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")

    testImplementation(kotlin("test"))
}

application {
    mainClass.set("io.github.chernetsovng.resiliencelab.cli.MainKt")
}

tasks.test {
    useJUnitPlatform()
    workingDir = rootProject.projectDir
}

tasks.run {
    workingDir = rootProject.projectDir
}
