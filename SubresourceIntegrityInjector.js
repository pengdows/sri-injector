const fs = require('fs-extra')
const crypto = require('crypto')
const path = require('path')
const HashAlgos = require('./HashAlgo');

class SubresourceIntegrityInjector {

    validateHashName(algorithmName) {

        const selectedAlgorithm = HashAlgos[algorithmName] || 'sha384'
        return selectedAlgorithm
    }

    replaceTags(htmlContent, tag, attribute) {
        const regex = new RegExp(`<${tag}[^>]* ${attribute}="([^"]+)"( /)?>`, 'g')
        return htmlContent.replace(regex, (match, src, selfClose) => {
            const content = fs.readFileSync(path.join(this.outputDir, src))
            const integrity = this.calculateBase64Hash(content)
            return `<${tag} ${attribute}="${src}" integrity="${this.algorithm}-${integrity}" crossorigin="anonymous"${selfClose || ''}>`
        })
    }

    // Function to calculate hash for Subresource Integrity
    calculateBase64Hash(content) {
        const hash = crypto.createHash(this.algorithm);
        hash.update(content);
        const base64Hash = hash.digest('base64')
        return base64Hash;
    };

    insertSRIInHTML(outputDir, algorithm = 'sha384') {
        this.outputDir = outputDir
        this.algorithm = this.validateHashName(algorithm)
        const p = new Promise((resolve, reject) => {
            try {
                const htmlFilePath = path.join(outputDir, 'index.html')

                if (!fs.existsSync(htmlFilePath)) {
                    throw new Error('index.html not found')
                }
                let htmlContent = fs.readFileSync(htmlFilePath, 'utf8')

                htmlContent = this.replaceTags(htmlContent, 'script', 'src')
                htmlContent = this.replaceTags(htmlContent, 'link', 'href')
                // Save updated HTML
                fs.writeFileSync(htmlFilePath, htmlContent)
                resolve()
            } catch (e) {
                reject(e)
            }

        });
        return p;
    }
}

module.exports = SubresourceIntegrityInjector
