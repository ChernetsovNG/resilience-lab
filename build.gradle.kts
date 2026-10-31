plugins {
    kotlin("jvm") version "2.4.21" apply false
    kotlin("plugin.serialization") version "2.4.21" apply false
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0" apply false
}

val updatingFixtures =
    listOf("UPDATE_SCHEMAS", "UPDATE_OPENAPI", "UPDATE_SERIES_GOLDEN")
        .any { providers.environmentVariable(it).isPresent }

subprojects {
    tasks.withType<Test>().configureEach {
        outputs.upToDateWhen { !updatingFixtures }
        outputs.doNotCacheIf("Repository fixtures are being regenerated") { updatingFixtures }
    }
    plugins.withId("org.jetbrains.kotlin.jvm") {
        apply(plugin = "org.jlleitschuh.gradle.ktlint")
        apply(plugin = "jacoco")
        dependencies.add("testImplementation", "org.assertj:assertj-core:3.27.7")
        tasks.named("check") {
            dependsOn("ktlintCheck", "jacocoTestReport")
        }
        tasks.named<org.gradle.testing.jacoco.tasks.JacocoReport>("jacocoTestReport") {
            dependsOn("test")
            reports {
                html.required.set(true)
                xml.required.set(true)
            }
        }
    }
}
