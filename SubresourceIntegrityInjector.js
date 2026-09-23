const fs = require('fs-extra')
const crypto = require('crypto')
const path = require('path')
const cheerio = require('cheerio')
const HashAlgos = require('./HashAlgo');

class SubresourceIntegrityInjector {

    validateHashName(algorithmName) {
        const selectedAlgorithm = HashAlgos[algorithmName] || 'sha384'
        return selectedAlgorithm
    }

    /**
     * Calculates hash for Subresource Integrity
     */
    calculateBase64Hash(content, algorithm) {
        const hash = crypto.createHash(algorithm);
        hash.update(content);
        return hash.digest('base64');
    };

    /**
     * Processes a single HTML file to inject SRI attributes.
     */
    async processFile(filePath, algorithm) {
        let htmlContent = await fs.readFile(filePath, 'utf8');
        const $ = cheerio.load(htmlContent, {
            xml: {
                decodeEntities: false // Preserve entities
            }
        }, false);

        const tagsToProcess = [
            { tag: 'script', attribute: 'src' },
            { tag: 'link[rel="stylesheet"]', attribute: 'href' },
            { tag: 'link[rel="preload"][as="script"]', attribute: 'href' },
            { tag: 'link[rel="preload"][as="style"]', attribute: 'href' }
        ];

        let modified = false;

        for (const { tag, attribute } of tagsToProcess) {
            const elements = $(tag).toArray();
            for (const el of elements) {
                const $el = $(el);
                const resourcePath = $el.attr(attribute);

                // Skip external resources or those already having integrity
                if (!resourcePath || resourcePath.startsWith('http') || resourcePath.startsWith('//') || $el.attr('integrity')) {
                    continue;
                }

                // Security: Prevent path traversal
                const fullPath = path.resolve(this.outputDir, resourcePath);
                if (!fullPath.startsWith(path.resolve(this.outputDir))) {
                    console.warn(`Skipping potential path traversal: ${resourcePath}`);
                    continue;
                }

                try {
                    const content = await fs.readFile(fullPath);
                    const hash = this.calculateBase64Hash(content, algorithm);
                    $el.attr('integrity', `${algorithm}-${hash}`);
                    $el.attr('crossorigin', 'anonymous');
                    modified = true;
                } catch (err) {
                    if (err.code === 'ENOENT') {
                        console.error(`Error: The linked resource "${resourcePath}" could not be found at "${fullPath}". Please verify that this file exists in your output directory.`);
                    } else {
                        console.error(`Error: Could not process resource "${resourcePath}": ${err.message}`);
                    }
                }
            }
        }

        if (modified) {
            await fs.writeFile(filePath, $.html());
        }
    }

    /**
     * Entry point to scan outputDir and inject SRI attributes into HTML files.
     */
    async insertSRIInHTML(outputDir, algorithm = 'sha384') {
        this.outputDir = path.resolve(outputDir);
        this.algorithm = this.validateHashName(algorithm);

        if (!fs.existsSync(this.outputDir)) {
            throw new Error(`Output directory not found: ${outputDir}`);
        }

        // Find all HTML files in the output directory (Phase 2 Roadmap)
        const files = await fs.readdir(this.outputDir);
        const htmlFiles = files.filter(f => f.endsWith('.html')).map(f => path.join(this.outputDir, f));

        if (htmlFiles.length === 0) {
            console.warn('No HTML files found in output directory.');
            return;
        }

        await Promise.all(htmlFiles.map(file => this.processFile(file, this.algorithm)));
    }
}

module.exports = SubresourceIntegrityInjector
