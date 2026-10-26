plugins {
    kotlin("jvm") version "2.4.21" apply false
    kotlin("plugin.serialization") version "2.4.21" apply false
}

subprojects {
    plugins.withId("org.jetbrains.kotlin.jvm") {
        dependencies.add("testImplementation", "org.assertj:assertj-core:3.27.7")
    }
}
