plugins {
    kotlin("jvm")
    application
}

kotlin {
    jvmToolchain(25)
}

dependencies {
    implementation(project(":core"))

    testImplementation(kotlin("test"))
}

application {
    mainClass.set("resiliencelab.cli.MainKt")
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
    inputs
        .dir(rootProject.file("examples"))
        .withPropertyName("exampleWorkspace")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    inputs
        .files(rootProject.fileTree("schemas") { include("*.schema.json") })
        .withPropertyName("documentSchemas")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    inputs
        .files(tasks.installDist)
        .withPropertyName("installedCli")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}

tasks.run {
    workingDir = rootProject.projectDir
}
