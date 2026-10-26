plugins {
    kotlin("jvm") version "2.4.21" apply false
    kotlin("plugin.serialization") version "2.4.21" apply false
    id("org.jlleitschuh.gradle.ktlint") version "14.2.0" apply false
}

val coverageFloors = mapOf(
    ":core" to ("0.95" to "0.85"),
    ":apps:cli" to ("0.85" to "0.60"),
    ":apps:server" to ("0.75" to "0.60"),
)

subprojects {
    plugins.withId("org.jetbrains.kotlin.jvm") {
        apply(plugin = "org.jlleitschuh.gradle.ktlint")
        apply(plugin = "jacoco")
        dependencies.add("testImplementation", "org.assertj:assertj-core:3.27.7")
        val (lineFloor, branchFloor) = coverageFloors.getValue(path)
        tasks.named("check") {
            dependsOn("ktlintCheck", "jacocoTestReport", "jacocoTestCoverageVerification")
        }
        tasks.named<org.gradle.testing.jacoco.tasks.JacocoReport>("jacocoTestReport") {
            dependsOn("test")
            reports {
                html.required.set(true)
                xml.required.set(true)
            }
        }
        tasks.named<org.gradle.testing.jacoco.tasks.JacocoCoverageVerification>("jacocoTestCoverageVerification") {
            dependsOn("test")
            violationRules {
                rule {
                    limit {
                        counter = "LINE"
                        minimum = lineFloor.toBigDecimal()
                    }
                }
                rule {
                    limit {
                        counter = "BRANCH"
                        minimum = branchFloor.toBigDecimal()
                    }
                }
            }
        }
    }
}
