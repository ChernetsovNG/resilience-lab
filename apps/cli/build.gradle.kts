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

tasks.startScripts {
    val script = windowsScript
    doLast {
        script.writeText(
            script.readText().replace(Regex("set CLASSPATH=.*")) {
                "set CLASSPATH=%APP_HOME%\\lib\\*"
            },
        )
    }
}

tasks.test {
    dependsOn("installDist")
    useJUnitPlatform()
    workingDir = rootProject.projectDir
}

tasks.run {
    workingDir = rootProject.projectDir
}
