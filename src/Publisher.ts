import { MyPluginSettings } from "./Settings";
import FolderFile from "./FolderFile.json";

import { traverse, filter } from "@atlaskit/adf-utils/traverse";
import * as SparkMD5 from "spark-md5";
import { doc, p } from "@atlaskit/adf-utils/builders";
import { ADFEntity } from "@atlaskit/adf-utils/types";
import MdToADF from "./mdToADF";
import {
	ConfluenceClient,
	LoaderAdaptor,
	MarkdownFile,
} from "./adaptors/types";
import { MermaidRenderer, ChartData } from "./mermaid_renderers/types";
import * as path from "path";
import { JSONDocNode } from "@atlaskit/editor-json-transformer";
import { UploadResults } from "./CompletedView";
import stringifyObject from "stringify-object";

const mdToADFConverter = new MdToADF();

interface FilePublishResult {
	successfulUpload: boolean;
	absoluteFilePath: string;
	reason?: string;
}

export interface AdfFile {
	folderName: string;
	absoluteFilePath: string;
	fileName: string;
	contents: JSONDocNode;
	pageTitle: string;
	frontmatter: {
		[key: string]: unknown;
	};
	tags: string[];
	pageId: string | undefined;
	dontChangeParentPageId: boolean;
	spaceKey?: string;
}

interface ConfluenceNode {
	file: AdfFile;
	version: number;
	existingAdf: string;
	parentPageId: string;
}
interface ConfluenceTreeNode {
	file: AdfFile;
	version: number;
	existingAdf: string;
	children: ConfluenceTreeNode[];
}

function flattenTree(
	node: ConfluenceTreeNode,
	parentPageId?: string
): ConfluenceNode[] {
	const nodes: ConfluenceNode[] = [];
	const { file, version, existingAdf, children } = node;

	if (parentPageId) {
		nodes.push({
			file,
			version,
			existingAdf,
			parentPageId: parentPageId,
		});
	}

	if (children) {
		children.forEach((child) => {
			nodes.push(...flattenTree(child, file.pageId));
		});
	}

	return nodes;
}

export class Publisher {
	confluenceClient: ConfluenceClient;
	blankPageAdf: string = JSON.stringify(doc(p("Page not published yet")));
	adaptor: LoaderAdaptor;
	settings: MyPluginSettings;
	mermaidRenderer: MermaidRenderer;

	constructor(
		adaptor: LoaderAdaptor,
		settings: MyPluginSettings,
		confluenceClient: ConfluenceClient,
		mermaidRenderer: MermaidRenderer
	) {
		this.adaptor = adaptor;
		this.settings = settings;
		this.mermaidRenderer = mermaidRenderer;

		this.confluenceClient = confluenceClient;
	}

	async doPublish(publishFilter?: string): Promise<UploadResults> {
		const parentPage = await this.confluenceClient.content.getContentById({
			id: this.settings.confluenceParentId,
			expand: ["body.atlas_doc_format", "space"],
		});
		if (!parentPage.space) {
			throw new Error("Missing Space Key");
		}

		const spaceToPublishTo = parentPage.space;

		const files = await this.adaptor.getMarkdownFilesToUpload();
		const folderTree = createFolderStructure(files);
		const confluencePageTree = await this.createFileStructureInConfluence(
			folderTree,
			spaceToPublishTo.key,
			parentPage.id,
			parentPage.id,
			false
		);
		let confluencePagesToPublish = flattenTree(confluencePageTree);

		const fileToPageIdMap: Record<string, AdfFile> = {};

		confluencePagesToPublish.forEach((node) => {
			if (!node.file.pageId) {
				throw new Error("Missing Page ID");
			}

			fileToPageIdMap[node.file.fileName] = node.file;
		});

		confluencePagesToPublish.forEach((node) => {
			node.file.contents = traverse(node.file.contents, {
				text: (node, _parent) => {
					if (
						node.marks &&
						node.marks[0].type === "link" &&
						node.marks[0].attrs
					) {
						if (
							typeof node.marks[0].attrs.href === "string" &&
							node.marks[0].attrs.href.startsWith("wikilink")
						) {
							const wikilinkUrl = new URL(
								node.marks[0].attrs.href
							);
							const pagename = `${wikilinkUrl.pathname}.md`;

							const linkPage = fileToPageIdMap[pagename];
							if (linkPage) {
								const confluenceUrl = `${this.settings.confluenceBaseUrl}/wiki/spaces/${linkPage.spaceKey}/pages/${linkPage.pageId}${wikilinkUrl.hash}`;
								node.marks[0].attrs.href = confluenceUrl;
								if (node.text === wikilinkUrl.pathname) {
									node.type = "inlineCard";
									node.attrs = {
										url: node.marks[0].attrs.href,
									};
									delete node.marks;
									delete node.text;
									return node;
								}
							} else {
								node.marks.remove(node.marks[0]);
							}
							return node;
						}
					}
				},
			}) as JSONDocNode;
		});

		if (publishFilter) {
			confluencePagesToPublish = confluencePagesToPublish.filter(
				(file) => file.file.absoluteFilePath === publishFilter
			);
		}

		const adrFileTasks = confluencePagesToPublish.map((file) => {
			return this.publishFile(file);
		});

		const adrFiles = await Promise.all(adrFileTasks);

		const returnVal: UploadResults = {
			successfulUploads: 0,
			errorMessage: null,
			failedFiles: [],
		};

		adrFiles.forEach((element) => {
			if (element.successfulUpload) {
				returnVal.successfulUploads = returnVal.successfulUploads + 1;
				return;
			}

			returnVal.failedFiles.push({
				fileName: element.absoluteFilePath,
				reason: element.reason ?? "No Reason Provided",
			});
		});

		return returnVal;
	}

	async createFileStructureInConfluence(
		node: TreeNode,
		spaceKey: string,
		parentPageId: string,
		topPageId: string,
		createPage: boolean
	): Promise<ConfluenceTreeNode> {
		if (!node.file) {
			throw new Error("Missing file on node");
		}

		let version: number;
		let existingAdf: string | undefined;

		if (createPage) {
			const pageDetails = await this.ensurePageExists(
				node.file,
				spaceKey,
				parentPageId,
				topPageId
			);
			node.file.pageId = pageDetails.id;
			node.file.spaceKey = pageDetails.spaceKey;
			version = pageDetails.version;
			existingAdf = pageDetails.existingAdf;
		} else {
			node.file.pageId = parentPageId;
			node.file.spaceKey = spaceKey;
			version = 0;
			existingAdf = "";
		}

		if (node.file.pageId === undefined) {
			throw new Error("Missing myPageId");
		}

		const nonNullMyPageId = node.file.pageId;

		const childDetailsTasks = node.children.map((childNode) => {
			return this.createFileStructureInConfluence(
				childNode,
				spaceKey,
				nonNullMyPageId,
				topPageId,
				true
			);
		});

		const childDetails = await Promise.all(childDetailsTasks);

		return {
			file: node.file,
			version,
			existingAdf: existingAdf ?? "",
			children: childDetails,
		};
	}

	async ensurePageExists(
		file: AdfFile,
		spaceKey: string,
		parentPageId: string,
		topPageId: string
	) {
		if (file.pageId) {
			const contentById =
				await this.confluenceClient.content.getContentById({
					id: file.pageId,
					expand: [
						"version",
						"body.atlas_doc_format",
						"ancestors",
						"space",
					],
				});

			if (!contentById.space?.key) {
				throw new Error("Missing Space Key");
			}

			return {
				id: contentById.id,
				title: file.pageTitle,
				version: contentById?.version?.number ?? 1,
				existingAdf: contentById?.body?.atlas_doc_format?.value,
				spaceKey: contentById.space.key,
			};
		}

		const searchParams = {
			type: "page",
			spaceKey,
			title: file.pageTitle,
			expand: ["version", "body.atlas_doc_format", "ancestors"],
		};
		const contentByTitle = await this.confluenceClient.content.getContent(
			searchParams
		);

		if (contentByTitle.size > 0) {
			const currentPage = contentByTitle.results[0];

			// TODO: Ensure is part of topPageId page tree
			console.log({ ancestors: currentPage.ancestors });
			if (
				!currentPage.ancestors?.some(
					(ancestor) => ancestor.id == topPageId
				)
			) {
				throw new Error(
					`${file.pageTitle} is trying to overwrite a page outside the page tree from the selected top page`
				);
			}

			await this.adaptor.updateMarkdownPageId(
				file.absoluteFilePath,
				currentPage.id
			);
			return {
				id: currentPage.id,
				title: file.pageTitle,
				version: currentPage?.version?.number ?? 1,
				existingAdf: currentPage?.body?.atlas_doc_format?.value,
				spaceKey,
			};
		} else {
			console.log("Creating page");
			const creatingBlankPageRequest = {
				space: { key: spaceKey },
				ancestors: [{ id: parentPageId }],
				title: file.pageTitle,
				type: "page",
				body: {
					// eslint-disable-next-line @typescript-eslint/naming-convention
					atlas_doc_format: {
						value: this.blankPageAdf,
						representation: "atlas_doc_format",
					},
				},
			};
			const pageDetails =
				await this.confluenceClient.content.createContent(
					creatingBlankPageRequest
				);

			await this.adaptor.updateMarkdownPageId(
				file.absoluteFilePath,
				pageDetails.id
			);
			return {
				id: pageDetails.id,
				title: file.pageTitle,
				version: pageDetails?.version?.number ?? 1,
				existingAdf: pageDetails?.body?.atlas_doc_format?.value,
				spaceKey,
			};
		}
	}

	async publishFile(node: ConfluenceNode): Promise<FilePublishResult> {
		try {
			if (!node.file.pageId) {
				throw new Error("Missing Page ID");
			}

			await this.updatePageContent(
				node.file.pageId,
				node.file.absoluteFilePath,
				node.file.contents,
				node.parentPageId,
				node.version,
				node.file.pageTitle,
				node.existingAdf,
				node.file.tags,
				node.file
			);

			return {
				successfulUpload: true,
				absoluteFilePath: node.file.absoluteFilePath,
			};
		} catch (e: unknown) {
			return {
				successfulUpload: false,
				absoluteFilePath: node.file.absoluteFilePath,
				reason: stringifyObject(e),
			};
		}
	}

	async updatePageContent(
		pageId: string,
		originFileAbsoluteFilePath: string,
		adf: ADFEntity,
		parentPageId: string,
		pageVersionNumber: number,
		pageTitle: string,
		currentContents: string,
		labels: string[],
		adfFile: AdfFile
	) {
		const updatedAdf = await this.uploadFiles(
			pageId,
			originFileAbsoluteFilePath,
			adf
		);

		const adr = JSON.stringify(updatedAdf);

		console.log("TESTING DIFF");
		console.log(currentContents);
		console.log(adr);

		if (currentContents === adr) {
			console.log("Page is the same not updating");
			return true;
		}

		const updateContentDetails = {
			id: pageId,
			...(adfFile.dontChangeParentPageId
				? {}
				: { ancestors: [{ id: parentPageId }] }),
			version: { number: pageVersionNumber + 1 },
			title: pageTitle,
			type: "page",
			body: {
				// eslint-disable-next-line @typescript-eslint/naming-convention
				atlas_doc_format: {
					value: adr,
					representation: "atlas_doc_format",
				},
			},
		};
		console.log({ updateContentDetails });
		await this.confluenceClient.content.updateContent(updateContentDetails);
		const getLabelsForContent = {
			id: pageId,
		};
		const currentLabels =
			await this.confluenceClient.contentLabels.getLabelsForContent(
				getLabelsForContent
			);
		if (currentLabels.size > 0) {
			console.log({ currentLabels });
		}

		for (const existingLabel of currentLabels.results) {
			if (!labels.includes(existingLabel.label)) {
				await this.confluenceClient.contentLabels.removeLabelFromContentUsingQueryParameter(
					{
						id: pageId,
						name: existingLabel.name,
					}
				);
			}
		}

		const labelsToAdd = [];
		for (const newLabel of labels) {
			if (
				currentLabels.results.findIndex(
					(item) => item.label === newLabel
				) === -1
			) {
				labelsToAdd.push({
					prefix: "global",
					name: newLabel,
				});
			}
		}

		if (labelsToAdd.length > 0) {
			await this.confluenceClient.contentLabels.addLabelsToContent({
				id: pageId,
				body: labelsToAdd,
			});
		}
	}

	async uploadFiles(
		pageId: string,
		pageFilePath: string,
		adr: ADFEntity
	): Promise<false | ADFEntity> {
		const mediaNodes = filter(
			adr,
			(node) =>
				node.type === "media" && (node.attrs || {})?.type === "file"
		);

		const mermaidNodes = filter(
			adr,
			(node) =>
				node.type == "codeBlock" &&
				(node.attrs || {})?.language === "mermaid"
		);

		const mermaidNodesToUpload = new Set(
			mermaidNodes.map((node) => {
				const mermaidDetails = getMermaidFileName(
					node?.content?.at(0)?.text
				);
				return {
					name: mermaidDetails.uploadFilename,
					data: mermaidDetails.mermaidText,
				} as ChartData;
			})
		).values();

		const mermaidChartsAsImages =
			await this.mermaidRenderer.captureMermaidCharts([
				...mermaidNodesToUpload,
			]);

		const currentUploadedAttachments =
			await this.confluenceClient.contentAttachments.getAttachments({
				id: pageId,
			});

		const currentAttachments = currentUploadedAttachments.results.reduce(
			(prev, curr) => {
				return {
					...prev,
					[`${curr.title}`]: {
						filehash: curr.metadata.comment,
						attachmentId: curr.extensions.fileId,
						collectionName: curr.extensions.collectionName,
					},
				};
			},
			{}
		);

		const imagesToUpload = new Set(
			mediaNodes.map((node) => node?.attrs?.url)
		).values();

		let imageMap: Record<string, UploadedImageData | null> = {};

		for (const imageUrl of imagesToUpload) {
			console.log({ testing: imageUrl });
			const filename = imageUrl.split("://")[1];
			const uploadedContent = await this.uploadFile(
				pageId,
				pageFilePath,
				filename,
				currentAttachments
			);

			imageMap = {
				...imageMap,
				[imageUrl]: uploadedContent,
			};
		}

		for (const mermaidImage of mermaidChartsAsImages) {
			const uploadedContent = await this.uploadBuffer(
				pageId,
				mermaidImage[0],
				mermaidImage[1],
				currentAttachments
			);

			imageMap = {
				...imageMap,
				[mermaidImage[0]]: uploadedContent,
			};
		}

		const afterAdf = traverse(adr, {
			media: (node, _parent) => {
				if (node?.attrs?.type === "file") {
					console.log({ node });
					if (!imageMap[node?.attrs?.url]) {
						return;
					}
					const mappedImage = imageMap[node.attrs.url];
					if (mappedImage !== null) {
						node.attrs.collection = mappedImage.collection;
						node.attrs.id = mappedImage.id;
						delete node.attrs.url;
						console.log({ node });
						return node;
					}
				}
			},
			codeBlock: (node, _parent) => {
				if (node?.attrs?.language === "mermaid") {
					const mermaidContent = node?.content?.at(0)?.text;
					if (!mermaidContent) {
						return;
					}
					const mermaidFilename = getMermaidFileName(mermaidContent);

					if (!imageMap[mermaidFilename.uploadFilename]) {
						return;
					}
					const mappedImage =
						imageMap[mermaidFilename.uploadFilename];
					if (mappedImage !== null) {
						node.type = "mediaSingle";
						node.attrs.layout = "center";
						if (node.content) {
							node.content = [
								{
									type: "media",
									attrs: {
										type: "file",
										collection: mappedImage.collection,
										id: mappedImage.id,
									},
								},
							];
						}
						delete node.attrs.language;
						return node;
					}
				}
			},
		});

		return afterAdf;
	}

	async uploadBuffer(
		pageId: string,
		uploadFilename: string,
		fileBuffer: Buffer,
		currentAttachments: Record<
			string,
			{ filehash: string; attachmentId: string; collectionName: string }
		>
	): Promise<UploadedImageData | null> {
		const spark = new SparkMD5.ArrayBuffer();
		const currentFileMd5 = spark.append(fileBuffer).end();

		if (
			!!currentAttachments[uploadFilename] &&
			currentAttachments[uploadFilename].filehash === currentFileMd5
		) {
			return {
				filename: uploadFilename,
				id: currentAttachments[uploadFilename].attachmentId,
				collection: currentAttachments[uploadFilename].collectionName,
			};
		}

		const attachmentDetails = {
			id: pageId,
			attachments: [
				{
					file: fileBuffer,
					filename: uploadFilename,
					minorEdit: false,
					comment: currentFileMd5,
					contentType: "image/png",
				},
			],
		};

		const attachmentResponse =
			await this.confluenceClient.contentAttachments.createOrUpdateAttachments(
				attachmentDetails
			);

		return {
			filename: uploadFilename,
			id: attachmentResponse.results[0].extensions.fileId,
			collection: `contentId-${attachmentResponse.results[0].container.id}`,
		};
	}

	async uploadFile(
		pageId: string,
		pageFilePath: string,
		fileNameToUpload: string,
		currentAttachments: Record<
			string,
			{ filehash: string; attachmentId: string; collectionName: string }
		>
	): Promise<UploadedImageData | null> {
		const testing = await this.adaptor.readBinary(
			fileNameToUpload,
			pageFilePath
		);
		if (testing) {
			const spark = new SparkMD5.ArrayBuffer();
			const currentFileMd5 = spark.append(testing.contents).end();
			const pathMd5 = SparkMD5.hash(testing.filePath);
			const uploadFilename = `${pathMd5}-${testing.filename}`;

			if (
				!!currentAttachments[uploadFilename] &&
				currentAttachments[uploadFilename].filehash === currentFileMd5
			) {
				return {
					filename: fileNameToUpload,
					id: currentAttachments[uploadFilename].attachmentId,
					collection:
						currentAttachments[uploadFilename].collectionName,
				};
			}

			const attachmentDetails = {
				id: pageId,
				attachments: [
					{
						file: Buffer.from(testing.contents),
						filename: uploadFilename,
						minorEdit: false,
						comment: currentFileMd5,
					},
				],
			};

			const attachmentResponse =
				await this.confluenceClient.contentAttachments.createOrUpdateAttachments(
					attachmentDetails
				);

			return {
				filename: fileNameToUpload,
				id: attachmentResponse.results[0].extensions.fileId,
				collection: `contentId-${attachmentResponse.results[0].container.id}`,
			};
		}

		return null;
	}
}

function getMermaidFileName(mermaidContent: string | undefined) {
	const mermaidText = mermaidContent ?? "flowchart LR\nid1[Missing Chart]";
	const pathMd5 = SparkMD5.hash(mermaidText);
	const uploadFilename = `RenderedMermaidChart-${pathMd5}.png`;
	return { uploadFilename, mermaidText };
}

interface UploadedImageData {
	filename: string;
	id: string;
	collection: string;
}

interface TreeNode {
	name: string;
	children: TreeNode[];
	file?: AdfFile;
}
const findCommonPath = (paths: string[]): string => {
	const [firstPath, ...rest] = paths;
	const commonPathParts = firstPath.split(path.sep);

	rest.forEach((filePath) => {
		const pathParts = filePath.split(path.sep);
		for (let i = 0; i < commonPathParts.length; i++) {
			if (pathParts[i] !== commonPathParts[i]) {
				commonPathParts.splice(i);
				break;
			}
		}
	});

	return commonPathParts.join(path.sep);
};

const createTreeNode = (name: string): TreeNode => ({
	name,
	children: [],
});

const addFileToTree = (
	treeNode: TreeNode,
	file: MarkdownFile,
	relativePath: string,
	fileNames: Set<string>
) => {
	const [folderName, ...remainingPath] = relativePath.split(path.sep);

	if (remainingPath.length === 0) {
		if (fileNames.has(file.fileName)) {
			throw new Error(
				`File name "${file.fileName}" is not unique across all folders.`
			);
		}
		fileNames.add(file.fileName);
		const adfFile = mdToADFConverter.convertMDtoADF(file);
		treeNode.children.push({
			...createTreeNode(folderName),
			file: adfFile,
		});
	} else {
		let childNode = treeNode.children.find(
			(node) => node.name === folderName
		);

		if (!childNode) {
			childNode = createTreeNode(folderName);
			treeNode.children.push(childNode);
		}

		addFileToTree(childNode, file, remainingPath.join(path.sep), fileNames);
	}
};

const createFolderStructure = (markdownFiles: MarkdownFile[]): TreeNode => {
	const commonPath = findCommonPath(
		markdownFiles.map((file) => file.absoluteFilePath)
	);
	const rootNode = createTreeNode(commonPath);
	const fileNames = new Set<string>();

	markdownFiles.forEach((file) => {
		const relativePath = path.relative(commonPath, file.absoluteFilePath);
		addFileToTree(rootNode, file, relativePath, fileNames);
	});
	console.log({ folderRoot: rootNode });
	const processNode = (node: TreeNode) => {
		if (!node.file) {
			const indexFile = node.children.find(
				(child) => path.parse(child.name).name === node.name
			);

			if (indexFile) {
				node.file = indexFile.file;
				node.children = node.children.filter(
					(child) => child !== indexFile
				);
			} else {
				node.file = {
					folderName: node.name,
					absoluteFilePath: path.join(commonPath, node.name),
					fileName: `${node.name}.md`,
					contents: FolderFile as JSONDocNode,
					pageTitle: node.name,
					frontmatter: {},
					tags: [],
					pageId: undefined,
					dontChangeParentPageId: false,
				};
			}
		}

		node.children.forEach(processNode);
	};

	processNode(rootNode);

	return rootNode;
};
