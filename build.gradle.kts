plugins {
    kotlin("jvm") version "2.4.21" apply false
    kotlin("plugin.serialization") version "2.4.21" apply false
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0" apply false
}

subprojects {
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
