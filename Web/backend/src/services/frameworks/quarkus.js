const fs = require('fs');
const path = require('path');

/**
 * Quarkus Framework Plugin (Java Cloud-Native)
 * Detects Quarkus by pom.xml or build.gradle containing "io.quarkus".
 * Must be registered BEFORE the generic Spring plugin.
 * Build: mvn package -DskipTests (or gradle quarkusBuild)
 * Preview: java -jar target/quarkus-app/quarkus-run.jar
 */
module.exports = {
  id: 'quarkus',
  detect: (targetDir) => {
    try {
      // Check pom.xml
      const pomPath = path.join(targetDir, 'pom.xml');
      if (fs.existsSync(pomPath)) {
        const content = fs.readFileSync(pomPath, 'utf8');
        if (content.includes('io.quarkus') || content.includes('quarkus-maven-plugin')) return true;
      }
      // Check build.gradle
      const gradlePaths = [
        path.join(targetDir, 'build.gradle'),
        path.join(targetDir, 'build.gradle.kts')
      ];
      for (const gp of gradlePaths) {
        if (fs.existsSync(gp)) {
          const content = fs.readFileSync(gp, 'utf8');
          if (content.includes('io.quarkus')) return true;
        }
      }
      // Check quarkus application.properties
      const appProps = path.join(targetDir, 'src', 'main', 'resources', 'application.properties');
      if (fs.existsSync(appProps)) {
        const content = fs.readFileSync(appProps, 'utf8');
        if (content.includes('quarkus.')) return true;
      }
    } catch (_) {}
    return false;
  },
  buildImage: 'maven:3.9-eclipse-temurin-21',
  previewImage: 'eclipse-temurin:21-jre-alpine',
  runCommand: 'mvn package -DskipTests -Dquarkus.package.type=fast-jar',
  getPreviewCommand: (workDir) => {
    // Quarkus fast-jar layout
    const fastJar = path.join(workDir, 'target', 'quarkus-app', 'quarkus-run.jar');
    if (fs.existsSync(fastJar)) {
      return {
        cmd: 'java',
        args: ['-jar', 'target/quarkus-app/quarkus-run.jar'],
        env: { QUARKUS_HTTP_HOST: '0.0.0.0', QUARKUS_HTTP_PORT: '${PORT:-8080}' }
      };
    }
    // Uber-jar fallback
    const targetDir = path.join(workDir, 'target');
    if (fs.existsSync(targetDir)) {
      const jars = fs.readdirSync(targetDir).filter(f => f.endsWith('-runner.jar') || f.endsWith('.jar'));
      if (jars.length > 0) {
        return {
          cmd: 'java',
          args: ['-jar', `target/${jars[0]}`],
          env: { QUARKUS_HTTP_HOST: '0.0.0.0', QUARKUS_HTTP_PORT: '${PORT:-8080}' }
        };
      }
    }
    return {
      cmd: 'echo',
      args: ['Quarkus JAR not found. Please check build output.'],
      env: {}
    };
  },
  getConfig: (targetDir) => {
    const isGradle =
      fs.existsSync(path.join(targetDir, 'build.gradle')) ||
      fs.existsSync(path.join(targetDir, 'build.gradle.kts'));
    if (isGradle) {
      return {
        buildImage: 'gradle:8.5-jdk21-jammy',
        previewImage: 'eclipse-temurin:21-jre-alpine',
        runCommand: './gradlew quarkusBuild -x test 2>/dev/null || gradle quarkusBuild -x test'
      };
    }
    return {
      buildImage: 'maven:3.9-eclipse-temurin-21',
      previewImage: 'eclipse-temurin:21-jre-alpine',
      runCommand: 'mvn package -DskipTests -Dquarkus.package.type=fast-jar'
    };
  },
  detectGui: (targetDir) => {
    const detectJavaGui = (dir) => {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const full = path.join(dir, f);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (f === 'node_modules' || f === '.git' || f === 'target' || f === 'build') continue;
            if (detectJavaGui(full)) return true;
          } else if (f.endsWith('.java')) {
            const content = fs.readFileSync(full, 'utf8');
            if (content.includes('javax.swing') || content.includes('java.awt') || content.includes('javafx.')) {
              return true;
            }
          }
        }
      } catch (_) {}
      return false;
    };
    return detectJavaGui(targetDir);
  },
  detectArchitecture: (targetDir) => {
    const { detectGeneralArchitecture } = require('../framework-detector.service');
    return detectGeneralArchitecture(targetDir);
  }
};
