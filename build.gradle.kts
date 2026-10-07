plugins {
    java
}

group = "dev.smp"
version = "1.0.0"

// Pass -PmcVersion=26.3 to build against a different Paper API (setup.ps1 does this).
val mcVersion = (findProperty("mcVersion") as String?) ?: "26.2"

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
    maven("https://jitpack.io")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:$mcVersion.build.+")
    // Displays arrived in DecentHolograms 2.10.0; build against the latest release.
    compileOnly("com.github.decentsoftware-eu:decentholograms:2.10.1")
}

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(25))
}

tasks.processResources {
    filesMatching("plugin.yml") {
        expand("version" to project.version)
    }
}
