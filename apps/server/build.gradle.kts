plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    application
    id("org.springframework.boot") version "4.1.2"
    id("io.spring.dependency-management") version "1.1.7"
}

kotlin {
    jvmToolchain(25)
}

dependencies {
    implementation(project(":core"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm") {
        version { strictly("1.11.0") }
    }
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-api:3.2.0")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-webmvc-test")
}

application {
    mainClass.set("resiliencelab.server.ResilienceLabApplicationKt")
}

configurations.named("ktlint") {
    resolutionStrategy.eachDependency {
        if (requested.group == "org.jetbrains.kotlin") {
            useVersion("2.1.0")
        }
    }
}

tasks.test {
    useJUnitPlatform()
    systemProperty("resilience-lab.workspace", rootProject.file("examples").absolutePath)
}

tasks.named<org.springframework.boot.gradle.tasks.run.BootRun>("bootRun") {
    workingDir = rootProject.projectDir
}

val e2eWorkspace = layout.buildDirectory.dir("e2e-workspace")

val prepareE2eWorkspace =
    tasks.register<Sync>("prepareE2eWorkspace") {
        description = "Copies examples/ into a scratch workspace for browser tests."
        from(rootProject.file("examples")) { exclude("**/.results/**") }
        into(e2eWorkspace)
        outputs.upToDateWhen { false }
    }

tasks.register<org.springframework.boot.gradle.tasks.run.BootRun>("bootRunE2e") {
    description = "Runs the server on a fresh copy of examples/, so browser tests never change the repository."
    group = "application"
    dependsOn(prepareE2eWorkspace)
    mainClass.set(application.mainClass)
    classpath = sourceSets["main"].runtimeClasspath
    workingDir = rootProject.projectDir
    systemProperty("resilience-lab.workspace", e2eWorkspace.get().asFile.absolutePath)
    systemProperty("server.port", providers.environmentVariable("E2E_BACKEND_PORT").orElse("8080").get())
}
